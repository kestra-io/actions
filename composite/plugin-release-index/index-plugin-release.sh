#!/bin/bash
# ==============================================================================
# SCRIPT FOR INDEXING KESTRA PLUGIN RELEASE

# USAGE:
#   ./index-plugin-release.sh <release_version> <webhook_url> [<dry-run>]
# ==============================================================================
set -euo pipefail

## ARGS
RELEASE_VERSION=$1
KESTRA_VERSION=$2
INDEXING_WEBHOOK=$3
DRY_RUN=${4:-false}

## FUNCTIONS
index() {
    gradleProject=$1

    # Read properties, default to null if empty
    GROUP=$(./gradlew -q "$gradleProject:properties" | grep '^group:' | cut -d':' -f2 | tr -d '[:space:]')
    ARTIFACT=$(./gradlew -q "$gradleProject:properties" | grep '^name:' | cut -d':' -f2 | tr -d '[:space:]')
    GIT_REPO=$(git config --get remote.origin.url)
    GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$GIT_BRANCH" == "HEAD" ]]; then
        # Detached HEAD: try to get exact tag
        GIT_TAG=$(git describe --tags --exact-match 2>/dev/null)
        
        if [[ -n "$GIT_TAG" ]]; then
            GIT_BRANCH="$GIT_TAG"
        else
            echo "Error: Not on a branch or a tagged commit."
            exit 1
        fi
    fi
    GIT_COMMIT=$(git rev-parse --short HEAD)
    
    semver_regex="^[0-9]+\.[0-9]+\.[0-9]+$"
    if [[ ! $RELEASE_VERSION =~ $semver_regex ]]; then
        echo "Error: Invalid pluginVersion '$RELEASE_VERSION'. Expected format MAJOR.MINOR.PATCH"
        exit 1
    fi

    if [[ ! $KESTRA_VERSION =~ $semver_regex ]]; then
        echo "Error: Invalid kestraVersion '$KESTRA_VERSION'. Expected format MAJOR.MINOR.PATCH"
        exit 1
    fi
    
    # Determine license based on artifact name
    if [[ "$ARTIFACT" == plugin-ee* ]]; then
        LICENSE="ENTERPRISE"
    else
        LICENSE="OPEN_SOURCE"
    fi
    
    # Replace empty strings with null for printing
    [ -z "$GROUP" ] && GROUP=null || GROUP="\"$GROUP\""
    [ -z "$ARTIFACT" ] && ARTIFACT=null || ARTIFACT="\"$ARTIFACT\""
    [ -z "$RELEASE_VERSION" ] && RELEASE_VERSION=null || RELEASE_VERSION="\"$RELEASE_VERSION\""
    [ -z "$KESTRA_VERSION" ] && KESTRA_VERSION=null || KESTRA_VERSION="\"$KESTRA_VERSION\""
    [ -z "$GIT_REPO" ] && GIT_REPO=null || GIT_REPO="\"$GIT_REPO\""
    [ -z "$GIT_BRANCH" ] && GIT_BRANCH=null || GIT_BRANCH="\"$GIT_BRANCH\""
    [ -z "$GIT_COMMIT" ] && GIT_COMMIT=null || GIT_COMMIT="\"$GIT_COMMIT\""
    [ -z "$LICENSE" ] && LICENSE=null || LICENSE="\"$LICENSE\""

    JSON_STRING="{\"groupId\": $GROUP, \"artifactId\": $ARTIFACT, \"version\": $RELEASE_VERSION, \"minCoreCompatibilityVersion\": $KESTRA_VERSION, \"repository\": $GIT_REPO, \"branch\": $GIT_BRANCH, \"commit\": $GIT_COMMIT, \"license\": $LICENSE}"

    echo "Plugin release to index: $JSON_STRING"
    
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "🚫 [DRY RUN] Skipping webhook"
    else
      if [ -n "$GROUP" ] && [ -n "$ARTIFACT" ] && [ -n "$RELEASE_VERSION" ] && [ -n "$KESTRA_VERSION" ]; then
        curl -X POST -H "Content-Type: application/json" -d "$JSON_STRING" "$INDEXING_WEBHOOK"
      else
        echo "🚫 Skipping webhook: some properties are null"
      fi
    fi
}

main() {
   # List all subproject paths
   SUB_PROJECTS=$(./gradlew -q properties | grep '^subprojects:')

   # Remove everything before the first bracket and after the last
   SUB_PROJECTS="${SUB_PROJECTS#*\[}"
   SUB_PROJECTS="${SUB_PROJECTS%\]*}"

   if [[ -z "$SUB_PROJECTS" ]]; then
     echo "🛠 Gradle mono project build detected"
     index ""
     exit 0;
   fi

   echo "🛠 Gradle multi projects build detected"

   SUB_PROJECTS=$(echo "$SUB_PROJECTS" | tr ',' '\n' | sed -E "s/.*'(:?)([^']+)'/\2/")

   # Convert to array
   readarray -t SUB_PROJECTS <<< "$SUB_PROJECTS"

   echo $SUB_PROJECTS;

   for P in "${SUB_PROJECTS[@]}"; do index $P; done
}

## MAIN
main

exit 0
