#!/usr/bin/env bash

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${GHCR_IMAGE:?GHCR_IMAGE is required}"
: "${DOCKERHUB_IMAGE:?DOCKERHUB_IMAGE is required}"

if [[ ! "$RELEASE_TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "RELEASE_TAG must be a stable semantic version such as v2.5.0." >&2
  exit 1
fi

version="${RELEASE_TAG#v}"
minor="${version%.*}"
ghcr_image="${GHCR_IMAGE,,}"
dockerhub_image="${DOCKERHUB_IMAGE,,}"
expected_revision="${EXPECTED_REVISION:-$(git rev-list -n 1 "$RELEASE_TAG")}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

platform_map() {
  docker buildx imagetools inspect "$1" --raw \
    | jq -r '.manifests[]
      | select(.platform.os == "linux")
      | select(.platform.architecture == "amd64" or .platform.architecture == "arm64")
      | "\(.platform.os)/\(.platform.architecture)=\(.digest)"' \
    | sort
}

verify_registry() {
  local image="$1"
  local registry_name="$2"
  local baseline="$work_dir/${registry_name}-${version}.txt"

  platform_map "${image}:${version}" > "$baseline"
  printf 'linux/amd64\nlinux/arm64\n' \
    | diff -u - <(cut -d= -f1 "$baseline")

  for tag in "$minor" latest; do
    platform_map "${image}:${tag}" > "$work_dir/${registry_name}-${tag}.txt"
    diff -u "$baseline" "$work_dir/${registry_name}-${tag}.txt"
  done
}

verify_labels() {
  local image="$1"
  local registry_name="$2"

  while IFS='=' read -r _ digest; do
    docker buildx imagetools inspect "${image}@${digest}" --format '{{json .Image}}' \
      | jq -e --arg version "$version" --arg revision "$expected_revision" '
          .config.Labels["org.opencontainers.image.version"] == $version
          and .config.Labels["org.opencontainers.image.revision"] == $revision
        ' > /dev/null
  done < "$work_dir/${registry_name}-${version}.txt"
}

verify_registry "$ghcr_image" ghcr
verify_registry "$dockerhub_image" dockerhub
diff -u "$work_dir/ghcr-${version}.txt" "$work_dir/dockerhub-${version}.txt"

verify_labels "$ghcr_image" ghcr
verify_labels "$dockerhub_image" dockerhub

echo "Verified ${version} and its ${minor}/latest aliases on GHCR and Docker Hub."
