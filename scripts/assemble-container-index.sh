#!/usr/bin/env bash
set -euo pipefail

: "${DIGEST_DIR:?DIGEST_DIR is required}"
: "${GHCR_IMAGE:?GHCR_IMAGE is required}"
: "${GHCR_METADATA:?GHCR_METADATA is required}"
: "${EXPECTED_REVISION:?EXPECTED_REVISION is required}"

ghcr_image="${GHCR_IMAGE,,}"
dockerhub_image="${DOCKERHUB_IMAGE:-}"
dockerhub_image="${dockerhub_image,,}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

declare -a digests
for arch in amd64 arm64; do
  digest="$(cat "$DIGEST_DIR/$arch")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  digests+=("$digest")
done

platform_map() {
  docker buildx imagetools inspect "$1" --raw \
    | jq -r '.manifests[]
      | select(.platform.os == "linux")
      | select(.platform.architecture == "amd64" or .platform.architecture == "arm64")
      | "\(.platform.os)/\(.platform.architecture)=\(.digest)"' | sort
}

prepare_registry() {
  local image="$1" metadata="$2" registry_name="$3"
  local -a tags sources
  jq -e '.tags | type == "array" and length > 0 and all(.[]; type == "string")' <<< "$metadata" >/dev/null
  mapfile -t tags < <(jq -r '.tags[]' <<< "$metadata")
  test "${#tags[@]}" -gt 0
  for tag in "${tags[@]}"; do
    [[ "$tag" == "$image:"* ]]
  done
  for digest in "${digests[@]}"; do sources+=("$image@$digest"); done
  # Check the inputs before moving any user-facing tag.
  for source in "${sources[@]}"; do
    platform_map "$source" >> "$work_dir/$registry_name-inputs"
  done
  sort -o "$work_dir/$registry_name-inputs" "$work_dir/$registry_name-inputs"
  diff -u <(printf 'linux/amd64\nlinux/arm64\n') \
    <(cut -d= -f1 "$work_dir/$registry_name-inputs")
  while IFS='=' read -r _ digest; do
    docker buildx imagetools inspect "$image@$digest" --format '{{json .Image}}' \
      | jq -e --arg revision "$EXPECTED_REVISION" \
          '.config.Labels["org.opencontainers.image.revision"] == $revision' >/dev/null
  done < "$work_dir/$registry_name-inputs"
}

publish_registry() {
  local image="$1" metadata="$2" registry_name="$3"
  local -a tags sources args annotations
  mapfile -t tags < <(jq -r '.tags[]' <<< "$metadata")
  for tag in "${tags[@]}"; do args+=(--tag "$tag"); done
  mapfile -t annotations < <(jq -r '.annotations[]?' <<< "$metadata")
  for annotation in "${annotations[@]}"; do
    annotation="${annotation#manifest:}"
    args+=(--annotation "index:$annotation")
  done
  for digest in "${digests[@]}"; do sources+=("$image@$digest"); done
  docker buildx imagetools create "${args[@]}" "${sources[@]}"
  for tag in "${tags[@]}"; do
    platform_map "$tag" > "$work_dir/$registry_name-map"
    diff -u "$work_dir/$registry_name-inputs" "$work_dir/$registry_name-map"
  done
}

prepare_registry "$ghcr_image" "$GHCR_METADATA" ghcr
if [ -n "${DOCKERHUB_METADATA:-}" ]; then
  : "${DOCKERHUB_IMAGE:?DOCKERHUB_IMAGE is required when mirroring}"
  prepare_registry "$dockerhub_image" "$DOCKERHUB_METADATA" dockerhub
  diff -u "$work_dir/ghcr-inputs" "$work_dir/dockerhub-inputs"
fi
publish_registry "$ghcr_image" "$GHCR_METADATA" ghcr
if [ -n "${DOCKERHUB_METADATA:-}" ]; then
  publish_registry "$dockerhub_image" "$DOCKERHUB_METADATA" dockerhub
  diff -u "$work_dir/ghcr-map" "$work_dir/dockerhub-map"
fi
echo "Verified combined architecture maps and revision labels."
