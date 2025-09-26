#!/bin/bash
# ==============================================================================
# SCRIPT FOR INDEXING KESTRA PLUGIN RELEASE

# USAGE:
#   ./index-plugin-release.sh <webhook_url> [<dry-run>]
# ==============================================================================
set -euo pipefail

## ARGS
INDEXING_WEBHOOK=$1
DRY_RUN=${2:-false}

## FUNCTIONS
index() {
    gradleProject=$1

    # Read properties, default to null if empty
    GROUP=$(./gradlew -q "$gradleProject:properties" | grep '^group:' | cut -d':' -f2 | tr -d '[:space:]')
    ARTIFACT=$(./gradlew -q "$gradleProject:properties" | grep '^archivesBaseName:' | cut -d':' -f2 | tr -d '[:space:]')
    VERSION=$(./gradlew -q "$gradleProject:properties" | grep '^version:' | cut -d':' -f2 | tr -d '[:space:]')
    MIN_CORE=$(./gradlew -q "$gradleProject:properties" | grep '^kestraVersion:' | cut -d':' -f2 | tr -d '[:space:]')

    # Replace empty strings with null for printing
    [ -z "$GROUP" ] && GROUP=null || GROUP="\"$GROUP\""
    [ -z "$ARTIFACT" ] && ARTIFACT=null || ARTIFACT="\"$ARTIFACT\""
    [ -z "$VERSION" ] && VERSION=null || VERSION="\"$VERSION\""
    [ -z "$MIN_CORE" ] && MIN_CORE=null || MIN_CORE="\"$MIN_CORE\""

    JSON_STRING="{\"groupId\": $GROUP, \"artifactId\": $ARTIFACT, \"version\": $VERSION, \"minCoreCompatibilityVersion\": $MIN_CORE}"

    echo "Plugin release to index: $JSON_STRING"
    
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "🚫 [DRY RUN] Skipping webhook"
    else
      if [ -n "$GROUP" ] && [ -n "$ARTIFACT" ] && [ -n "$VERSION" ] && [ -n "$MIN_CORE" ]; then
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

   if [[ "$SUB_PROJECTS" -eq "" ]]; then
    echo "🛠 Gradle mono project build detected"
     index
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