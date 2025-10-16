#!/bin/bash
# ==============================================================================
# RELEASE SCRIPT FOR KESTRA PLUGINS
#
# This script automates the release process for Kestra plugin repositories.
# It supports MAJOR, MINOR, and PATCH version releases based on Git branches.
#
# MAJOR and MINOR releases (e.g., 2.0.0 or 1.3.0):
# - Performed from the default branch (main or master)
# - Creates a new release branch if not already present (e.g., releases/v1.3.x)
# - Runs `./gradlew release`, which automatically creates a Git tag
# - Updates gradle.properties to the NEXT snapshot version (e.g., 1.4.0-SNAPSHOT)
#
# PATCH releases (e.g., 1.3.2):
# - Performed directly on an existing maintenance branch (e.g., releases/v1.3.x)
# - Updates gradle.properties to the patch version
# - Commits the change
# - Creates an annotated Git tag (e.g., v1.3.2)
# - Pushes the commit and the tag
#
# USAGE:
#   ./release.sh <releaseVersion> [nextVersion] [dry-run]
#
# EXAMPLES:
#   # MAJOR release (with next version)
#   ./release.sh 2.0.0 2.1.0-SNAPSHOT 1.1.0
#
#   # MINOR release (with next version)
#   ./release.sh 1.3.0 1.4.0-SNAPSHOT 1.1.0
#
#   # PATCH release (no next version)
#   ./release.sh 1.3.2 "" 1.1.0
#
#   # DRY RUN
#   ./release.sh 1.3.2 "" 1.1.0 true
# ==============================================================================

set -euo pipefail

RELEASE_VERSION=$1
NEXT_VERSION=${2:-}
KESTRA_VERSION=${3:-}
DRY_RUN=${4:-false}

DRY_RUN_SUFFIX=""
if [[ "$DRY_RUN" == "true" ]]; then
  DRY_RUN_SUFFIX=" (dry-run)"
fi

# Determine release type
if [[ -z "$NEXT_VERSION" ]]; then
  RELEASE_TYPE="PATCH"
elif [[ "$RELEASE_VERSION" =~ ^[0-9]+\.0\.0$ ]]; then
  RELEASE_TYPE="MAJOR"
elif [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[1-9][0-9]*\.0$ ]]; then
  RELEASE_TYPE="MINOR"
else
  RELEASE_TYPE="UNKNOWN"
fi

if [[ "$RELEASE_TYPE" == "UNKNOWN" ]]; then
  echo "❌ Unable to determine release type from version '$RELEASE_VERSION' with next version '$NEXT_VERSION'"
  exit 1
fi

echo "📦 Release Version: $RELEASE_VERSION"
echo "📦 Next Version: $NEXT_VERSION"
echo "🧪 Dry Run: $DRY_RUN"

# Override Git remote with PAT to allow pushing to protected branches
if [[ -n "${GITHUB_PAT:-}" ]]; then
  echo "🔐 Using GITHUB_PAT for authentication"
  REMOTE_URL=$(git config --get remote.origin.url | sed -E 's#https://([^@]*@)?#https://#')
  AUTHED_URL="https://x-access-token:${GITHUB_PAT}@${REMOTE_URL#https://}"
  git remote set-url origin "$AUTHED_URL"
fi

# Tag to be created
TAG="v${RELEASE_VERSION}"

# Extract X.Y for the maintenance branch
BASE_VERSION=$(echo "$RELEASE_VERSION" | grep -Eo '^[0-9]+\.[0-9]+')

# Branch to use for PATCH releases
RELEASE_BRANCH="releases/v${BASE_VERSION}.x"

# Detect the default branch (main or master)
DEFAULT_BRANCH=$(git remote show origin | grep 'HEAD branch' | cut -d ':' -f2 | tr -d ' ')

# Check if the tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "❌ Tag '$TAG' already exists. Aborting."
  exit 1
fi

# If NEXT_VERSION is not provided, this is a PATCH release
if [[ -z "$NEXT_VERSION" ]]; then
  echo "🛠 Detected PATCH release mode on branch $RELEASE_BRANCH"

  # Ensure the release branch exists remotely
  if ! git ls-remote --heads origin "$RELEASE_BRANCH" &>/dev/null; then
    echo "❌ Branch $RELEASE_BRANCH does not exist."
    exit 1
  fi

  # Checkout and update the release branch
  git checkout "$RELEASE_BRANCH"
  git pull origin "$RELEASE_BRANCH"

  echo "🔧 Updating gradle.properties with version=$RELEASE_VERSION"
  sed -i "s/^version=.*/version=${RELEASE_VERSION}/" gradle.properties

  if [[ -n "$KESTRA_VERSION" ]]; then
    echo "🔧 Overriding kestraVersion with: $KESTRA_VERSION"
    sed -i "s/^kestraVersion=.*/kestraVersion=${KESTRA_VERSION}/" gradle.properties
  fi

  git add gradle.properties
  git commit -m "chore(version): update to version '${RELEASE_VERSION}'"

  # Create the tag
  echo "🏷 Creating annotated tag: $TAG"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "🚫 [DRY RUN] Skipping: git tag -a $TAG -m \"$TAG\""
    echo "🚫 [DRY RUN] Skipping: git push origin $RELEASE_BRANCH && git push origin $TAG"
  else
    git tag -a "$TAG" -m "$TAG"
    git push origin "$RELEASE_BRANCH"
    git push origin "$TAG"
  fi

  echo "✅ Patch release $RELEASE_VERSION$DRY_RUN_SUFFIX completed!"
else
  echo "🚀 Detected $RELEASE_TYPE release mode on branch $DEFAULT_BRANCH"

  # Checkout and pull the default branch
  git checkout "$DEFAULT_BRANCH"
  git pull origin "$DEFAULT_BRANCH"

  # Ensure remote branch list is fresh
  git fetch origin

  # Check if remote release branch exists
  if ! git ls-remote --heads origin "$RELEASE_BRANCH" | grep -q "$RELEASE_BRANCH"; then
    echo "🌱 Creating release branch: $RELEASE_BRANCH"
    git checkout -b "$RELEASE_BRANCH"
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "🚫 [DRY RUN] Skipping: git push origin $RELEASE_BRANCH"
    else
      git push origin "$RELEASE_BRANCH"
    fi
  else
    echo "ℹ️ Branch '$RELEASE_BRANCH' already exists on remote."
  fi

  # Return to the default branch for the actual release
  git checkout "$DEFAULT_BRANCH"

  echo "🧪 Running Gradle release..."
  echo "ℹ️ Note: './gradlew release' will automatically create and push the Git tag '$TAG'"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "🚫 [DRY RUN] Skipping: ./gradlew release -Prelease.useAutomaticVersion=true -Prelease.releaseVersion=\"$RELEASE_VERSION\" -Prelease.newVersion=\"$NEXT_VERSION\""
  else
    # Perform the Gradle release (this creates, pushes the tag and updates to NEXT_VERSION (SNAPSHOT) on main branch)
    ./gradlew release \
      -Prelease.useAutomaticVersion=true \
      -Prelease.releaseVersion="$RELEASE_VERSION" \
      -Prelease.newVersion="$NEXT_VERSION"
  fi

  echo "✅ $RELEASE_TYPE release $RELEASE_VERSION$DRY_RUN_SUFFIX completed!"
fi
