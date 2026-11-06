#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mapfile -t declarations < "$root/docker/trivy/Dockerfile"
pattern='^FROM (aquasec/trivy:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64})$'
if [[ ${#declarations[@]} -ne 1 || ! ${declarations[0]} =~ $pattern ]]; then
    printf '%s\n' 'Expected one digest-pinned aquasec/trivy FROM declaration.' >&2
    exit 1
fi
printf '%s\n' "${BASH_REMATCH[1]}"
