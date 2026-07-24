#!/bin/bash
# Downloads the cloud-only plugins baked into the kestra-cloud image.
#
# Convention: every Maven package under the group "io.kestra.plugin.cloud" in the
# private Artifact Registry is a cloud plugin. These plugins are deliberately never
# indexed on api.kestra.io, so compatibility cannot be resolved through the plugin
# API. It is read from the pom instead: the io.kestra:platform entry in
# <dependencyManagement> is the plugin's kestraVersion at release time.
#
# For each plugin, the newest release compatible with KESTRA_VERSION is downloaded.
#
# ENV:
#   KESTRA_VERSION  Kestra version being built ("v2.0.3", "2.0.3" or a branch name)
#   PLUGINS_DIR     directory receiving the downloaded JARs
#
# Auth: ambient gcloud credentials (set up by google-github-actions/auth).
set -euo pipefail

readonly GROUP_ID="io.kestra.plugin.cloud"
readonly GROUP_ID_AS_PATH="io/kestra/plugin/cloud"

gcloud_artifacts() {
    gcloud artifacts "$@" --project=kestra-host --location=europe-west1 --repository=maven
}

# is_lower_or_equal A B -> true when version A <= version B
is_lower_or_equal() {
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]
}

# Prints the minimum Kestra version required by a plugin version, read from the
# io.kestra:platform BOM entry of its pom. Prints nothing when the pom has none.
minimum_kestra_version_of() {
    local plugin="$1"
    local version="$2"
    local pom_directory minimum
    pom_directory=$(mktemp -d)

    gcloud_artifacts files download --quiet --destination="$pom_directory" \
        "$GROUP_ID_AS_PATH/$plugin/$version/$plugin-$version.pom" > /dev/null

    minimum=$(grep -A3 '<groupId>io.kestra</groupId>' "$pom_directory"/*.pom \
        | grep -A2 '<artifactId>platform</artifactId>' \
        | grep -oP '(?<=<version>)[^<]+' | head -1 | sed 's/-SNAPSHOT$//' || true)

    rm -rf "$pom_directory"
    echo "$minimum"
}

mkdir -p "$PLUGINS_DIR"

# "v2.0.3" or "2.0.3-rc1" -> "2.0.3". A branch build (e.g. develop) has no
# version to compare against: fall back to 999.999.999 ("infinitely recent",
# same convention as kestractl resolveVersion) so every plugin version passes.
kestra_version=$(echo "${KESTRA_VERSION#v}" | sed -E 's/-rc[0-9]+$//')
if [[ ! "$kestra_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    kestra_version="999.999.999"
fi

# Two steps so a gcloud failure aborts the script (set -e) instead of being
# swallowed by the grep and mistaken for "no cloud plugin in the registry".
all_packages=$(gcloud_artifacts packages list --format='value(name)')
cloud_plugins=$(echo "$all_packages" | grep "^${GROUP_ID}:" | cut -d: -f2 || true)

if [ -z "$cloud_plugins" ]; then
    echo "No package under group $GROUP_ID in the registry, nothing to download."
    exit 0
fi

downloaded=0
for plugin in $cloud_plugins; do
    all_versions=$(gcloud_artifacts versions list --package="$GROUP_ID:$plugin" --format='value(name)')
    releases_newest_first=$(echo "$all_versions" | grep -v -- '-SNAPSHOT' | sort --version-sort --reverse || true)

    for version in $releases_newest_first; do
        minimum_kestra_version=$(minimum_kestra_version_of "$plugin" "$version")

        if [ -z "$minimum_kestra_version" ]; then
            echo "::warning::$GROUP_ID:$plugin:$version has no io.kestra:platform in its pom, skipping this version"
            continue
        fi
        if ! is_lower_or_equal "$minimum_kestra_version" "$kestra_version"; then
            echo "$plugin $version requires Kestra >= $minimum_kestra_version: too recent for $kestra_version, trying an older version"
            continue
        fi

        echo "$plugin -> $version (requires Kestra >= $minimum_kestra_version)"
        gcloud_artifacts files download --quiet --destination="$PLUGINS_DIR" \
            "$GROUP_ID_AS_PATH/$plugin/$version/$plugin-$version.jar" > /dev/null
        # gcloud names the downloaded file after the URL-encoded full path:
        # give it back its real name.
        if [ ! -f "$PLUGINS_DIR/$plugin-$version.jar" ]; then
            mv "$PLUGINS_DIR"/*"$plugin-$version.jar" "$PLUGINS_DIR/$plugin-$version.jar"
        fi
        downloaded=$((downloaded + 1))
        break
    done
done

if [ "$downloaded" -eq 0 ]; then
    echo "::error::Cloud plugins exist under $GROUP_ID but none is compatible with Kestra $kestra_version, refusing to ship an empty cloud image."
    exit 1
fi

echo "Downloaded cloud plugins:"
ls -l "$PLUGINS_DIR"
