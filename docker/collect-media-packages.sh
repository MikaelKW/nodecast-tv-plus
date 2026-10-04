#!/bin/sh
set -eu

root=/opt/media
record="$root/share/nodecast-runtime"
for tool in ffmpeg ffprobe; do
    nm -D "$root/bin/$tool" > "$record/$tool-dynamic-symbols.txt"
    # Theora retains a Cairo-linked telemetry facility in its shared decoder
    # library. The paired tools use its encoder/core API, not that decoder API.
    if grep -E ' U (rsvg_|pango_|cairo_|th_decode_|theora_decode_)' "$record/$tool-dynamic-symbols.txt"; then
        echo 'Unexpected media renderer or external Theora decoder import' >&2
        exit 1
    fi
done
# Resolve only actual linked runtime libraries. Ignore dpkg's informational
# diversion records and retry canonical paths on usr-merged distributions.
ldd "$root/bin/ffmpeg" "$root/bin/ffprobe" > "$record/build-linkage.txt"
if grep -F 'not found' "$record/build-linkage.txt"; then
    echo 'Unresolved media library' >&2
    exit 1
fi
awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' "$record/build-linkage.txt" | \
    sort -u > /tmp/media-libraries
lookup() {
    dpkg-query -S "$1" 2>/dev/null | grep -v '^diversion '
}
: > "$record/runtime-packages.txt"
while IFS= read -r library; do
    if ! match=$(lookup "$library" || lookup "$(readlink -f "$library")"); then
        echo "Unaccounted media library: $library" >&2
        exit 1
    fi
    package=$(printf '%s\n' "$match" | head -n 1 | sed 's/: .*//')
    dpkg-query -W -f='${binary:Package}\n' "$package" >> "$record/runtime-packages.txt"
done < /tmp/media-libraries
sort -u "$record/runtime-packages.txt" -o "$record/runtime-packages.txt"
test -s "$record/runtime-packages.txt"
