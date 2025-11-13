#!/bin/bash
# ==============================================================================
# RELEASE SCRIPT FOR KESTRA PLUGINS
#
# This script automates the release process for Kestra plugin repositories.
# It relies only on Git tags (no release branches) and runs `./gradlew release`.
#
# It validates that the provided RELEASE_VERSION matches the expected semantic
# version bump (major/minor/patch) according to Conventional Commits since the
# latest tag.
#
# Rules:
# - If commits contain "BREAKING CHANGE" or "feat!" → expect MAJOR bump (X++)
# - Else if commits contain "feat" → expect MINOR bump (Y++)
# - Else → expect PATCH bump (Z++)
#
# In addition, it supports a "hotfix" mode for older releases:
# - Provide a list of SHA1s as the 5th argument.
# - The script will switch to the previous tag (vX.Y.Z-1),
#   apply the cherry-picks, and create a new annotated tag (vX.Y.Z).
# - In case of conflict, it aborts immediately without tagging.
#
# USAGE:
#   ./release.sh <releaseVersion> [nextVersion] [kestraVersion] [dry-run] [commitsList]
#
# EXAMPLES:
#
# 🧱 Normal releases (Gradle-managed)
#
#   # Major release: 2.0.0 → next 2.0.1-SNAPSHOT
#   ./release.sh 2.0.0
#
#   # Minor release: 1.2.0 → next 1.2.1-SNAPSHOT
#   ./release.sh 1.2.0 "" 1.1.0
#
#   # Patch release: 1.1.1 → next 1.1.2-SNAPSHOT
#   ./release.sh 1.1.1
#
#   # With explicit next version and Kestra version override
#   ./release.sh 1.3.0 1.3.1-SNAPSHOT 1.2.0
#
#   # Dry run simulation (no push, no tag)
#   ./release.sh 1.3.0 "" 1.1.0 true
#
# 🛠 Hotfix releases (manual cherry-picks on older major/minor)
#
#   # Apply commits abc123 and def456 on top of v1.0.1, then tag v1.0.2
#   ./release.sh 1.0.2 "" "" false "abc123,def456"
#
#   # Dry-run of the same hotfix (no cherry-pick or tag created)
#   ./release.sh 1.0.2 "" "" true "abc123,def456"
# ==============================================================================

set -euo pipefail
rm -f .git/index.lock || true

RELEASE_VERSION=$1
NEXT_VERSION=${2:-}
KESTRA_VERSION=${3:-}
DRY_RUN=${4:-false}
COMMITS_LIST=${5:-}

# ------------------------------------------------------------------------------
# Find the latest tag and extract current version
# ------------------------------------------------------------------------------
echo "🔍 Detecting latest tag..."
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
CURRENT_VERSION=${LAST_TAG#v}
IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT_VERSION"

IFS='.' read -r REL_MAJOR REL_MINOR REL_PATCH <<< "$RELEASE_VERSION"

echo "🔖 Last tag: ${LAST_TAG}"
echo "📦 Proposed release: ${RELEASE_VERSION}"
echo "📦 Proposed next version: ${NEXT_VERSION:-<none>}"

# ------------------------------------------------------------------------------
# Mode HOTFIX (if SHA list provided)
# ------------------------------------------------------------------------------
if [[ -n "$COMMITS_LIST" ]]; then
  echo "🧩 Hotfix mode detected — applying fixes for ${RELEASE_VERSION}"
  IFS='.' read -r MAJOR MINOR PATCH <<< "$RELEASE_VERSION"
  PREV_PATCH=$((PATCH - 1))
  BASE_TAG="v${MAJOR}.${MINOR}.${PREV_PATCH}"

  echo "🔎 Base tag: ${BASE_TAG}"
  if ! git rev-parse "$BASE_TAG" >/dev/null 2>&1; then
    echo "❌ Base tag '$BASE_TAG' not found. Cannot perform hotfix."
    exit 1
  fi

  echo "🔀 Switching to detached HEAD at ${BASE_TAG}"
  git switch --detach "$BASE_TAG"

  # ----------------------------------------------------------------------------
  # 🔢 Bump gradle.properties version to the hotfix version
  # ----------------------------------------------------------------------------
  echo "📝 Updating version in gradle.properties to ${RELEASE_VERSION}"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "🚫 [DRY RUN] Would set version=${RELEASE_VERSION} in gradle.properties"
  else
    if grep -q '^version=' gradle.properties; then
      sed -i "s/^version=.*/version=${RELEASE_VERSION}/" gradle.properties
    else
      echo "version=${RELEASE_VERSION}" >> gradle.properties
    fi
    git add gradle.properties
    git commit -m "chore(version): bump to ${RELEASE_VERSION} for hotfix"
  fi

  # ----------------------------------------------------------------------------
  # 🔧 Apply cherry-picks
  # ----------------------------------------------------------------------------
  echo "🔧 Applying cherry-picks..."
  IFS=',' read -ra SHAS <<< "$COMMITS_LIST"
  for SHA in "${SHAS[@]}"; do
    echo "➡️  Cherry-picking $SHA"
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "🚫 [DRY RUN] Skipping cherry-pick of $SHA"
    else
      if ! git cherry-pick "$SHA"; then
        echo "❌ Conflict during cherry-pick of $SHA"
        echo "   Aborting cherry-pick and reverting state to ${BASE_TAG}."
        git cherry-pick --abort || true
        git reset --hard "$BASE_TAG"
        exit 1
      fi
    fi
  done

  # ----------------------------------------------------------------------------
  # 🏷 Create and push the tag
  # ----------------------------------------------------------------------------
  echo "🏷 Creating annotated hotfix tag v${RELEASE_VERSION}"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "🚫 [DRY RUN] Would create and push tag v${RELEASE_VERSION}"
  else
    git tag -a "v${RELEASE_VERSION}" -m "v${RELEASE_VERSION}"
    git push origin "v${RELEASE_VERSION}"
  fi

  echo "✅ Hotfix v${RELEASE_VERSION} successfully created and pushed."
  exit 0
fi

# ------------------------------------------------------------------------------
# Analyze commits since last tag (for normal Gradle releases)
# ------------------------------------------------------------------------------
echo "🔎 Analyzing commits since ${LAST_TAG}..."
if git rev-parse "$LAST_TAG" >/dev/null 2>&1; then
  COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"%s%n%b" 2>/dev/null | tr '[:upper:]' '[:lower:]')
else
  echo "ℹ️ No previous tag found — treating this as the first release."
  COMMITS=$(git log HEAD --pretty=format:"%s%n%b" 2>/dev/null | tr '[:upper:]' '[:lower:]')
  LAST_TAG="(none)"
fi

if [[ -z "$COMMITS" ]]; then
  echo "⚠️  No commits found since ${LAST_TAG}! Nothing to release."
  exit 0
fi

HAS_BREAKING=false
HAS_FEAT=false
HAS_FIX=false

# Detection logic — unquoted $COMMITS to preserve newlines for grep
if echo "$COMMITS" | grep -qE 'breaking change|feat!'; then
  HAS_BREAKING=true
elif echo "$COMMITS" | grep -qE '^feat(\(|:|\s)'; then
  HAS_FEAT=true
elif echo "$COMMITS" | grep -qE '^fix(\(|:|\s)'; then
  HAS_FIX=true
else
  echo "ℹ️ No feat/fix/breaking commits found — treating as PATCH release (chore/refactor/docs/etc detected)."
fi

# ------------------------------------------------------------------------------
# Determine expected version bump
# ------------------------------------------------------------------------------
EXP_MAJOR=$CUR_MAJOR
EXP_MINOR=$CUR_MINOR
EXP_PATCH=$CUR_PATCH

if [[ "$HAS_BREAKING" == true ]]; then
  ((EXP_MAJOR++)) || true; EXP_MINOR=0; EXP_PATCH=0
  EXPECTED_TYPE="MAJOR"
elif [[ "$HAS_FEAT" == true ]]; then
  ((EXP_MINOR++)) || true; EXP_PATCH=0
  EXPECTED_TYPE="MINOR"
else
  ((EXP_PATCH++)) || true
  EXPECTED_TYPE="PATCH"
fi

EXPECTED_VERSION="${EXP_MAJOR}.${EXP_MINOR}.${EXP_PATCH}"

# ------------------------------------------------------------------------------
# Validate the provided release version
# ------------------------------------------------------------------------------
if [[ "$RELEASE_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "❌ Version mismatch detected!"
  echo "   → Commits since ${LAST_TAG} suggest a *${EXPECTED_TYPE}* bump"
  echo "   → Expected version: ${EXPECTED_VERSION}"
  echo "   → Provided version: ${RELEASE_VERSION}"
  echo ""
  echo "💡 Fix: adjust your release version accordingly or review commits."
  exit 1
fi

echo "✅ Version check passed — ${RELEASE_VERSION} is consistent with commit history (${EXPECTED_TYPE} bump)."

# ------------------------------------------------------------------------------
# Auto-set NEXT_VERSION if not provided
# ------------------------------------------------------------------------------
if [[ -z "$NEXT_VERSION" ]]; then
  IFS='.' read -r MAJ MIN PATCH <<< "$RELEASE_VERSION"
  NEXT_PATCH=$((PATCH + 1))
  NEXT_VERSION="${MAJ}.${MIN}.${NEXT_PATCH}-SNAPSHOT"
  echo "ℹ️ No nextVersion provided — automatically set to ${NEXT_VERSION}"
fi

# ------------------------------------------------------------------------------
# Configure Git authentication if GITHUB_PAT is provided
# ------------------------------------------------------------------------------
if [[ -n "${GITHUB_PAT:-}" ]]; then
  echo "🔐 Configuring authentication with GITHUB_PAT"
  REMOTE_URL=$(git config --get remote.origin.url | sed -E 's#https://([^@]*@)?#https://#')
  AUTHED_URL="https://x-access-token:${GITHUB_PAT}@${REMOTE_URL#https://}"
  git remote set-url origin "$AUTHED_URL"
fi

# ------------------------------------------------------------------------------
# Override kestraVersion if provided
# ------------------------------------------------------------------------------
if [[ -n "$KESTRA_VERSION" ]]; then
  echo "🔧 Overriding kestraVersion with: $KESTRA_VERSION"
  sed -i "s/^kestraVersion=.*/kestraVersion=${KESTRA_VERSION}/" gradle.properties
  git add gradle.properties
  if ! git diff --cached --quiet; then
    git commit -m "chore(version): override kestraVersion to '${KESTRA_VERSION}'"
  fi
fi

# ------------------------------------------------------------------------------
# Run Gradle release (automatic tagging & snapshot bump)
# ------------------------------------------------------------------------------
TAG="v${RELEASE_VERSION}"
DEFAULT_BRANCH=$(git remote show origin | grep 'HEAD branch' | cut -d ':' -f2 | tr -d ' ')
git fetch origin --tags

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag '$TAG' already exists. Aborting."
  exit 1
fi

echo "🚀 Running Gradle release (tag + snapshot handled automatically)..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "🚫 [DRY RUN] Would execute:"
  echo "./gradlew release -Prelease.useAutomaticVersion=true -Prelease.releaseVersion='${RELEASE_VERSION}' -Prelease.newVersion='${NEXT_VERSION}'"
else
  ./gradlew release \
    -Prelease.useAutomaticVersion=true \
    -Prelease.releaseVersion="${RELEASE_VERSION}" \
    -Prelease.newVersion="${NEXT_VERSION}"
fi

echo ""
echo "✅ Release ${RELEASE_VERSION} (${EXPECTED_TYPE}) completed successfully!"
echo "   - Tag: v${RELEASE_VERSION}"
echo "   - Next version: ${NEXT_VERSION}"
echo "   - Branch: ${DEFAULT_BRANCH}"
echo "   - Kestra version: ${KESTRA_VERSION:-<unchanged>}"
echo "   - Dry run: ${DRY_RUN}"
