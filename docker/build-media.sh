#!/bin/sh
set -eu

version=9.0.2
digest=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
fingerprint=FCF986EA15E6E293A5644F10B4322F04D67658D8
root=/opt/media
record="$root/share/nodecast-runtime"
mkdir -p "$record/sources" /tmp/media-source /tmp/media-keyring
chmod 700 /tmp/media-keyring
export GNUPGHOME=/tmp/media-keyring
cd /tmp/media-source

curl --fail --location --retry 3 --proto '=https' -o source.tar.xz "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz"
curl --fail --location --retry 3 --proto '=https' -o source.tar.xz.asc "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz.asc"
curl --fail --location --retry 3 --proto '=https' -o release-key.asc https://ffmpeg.org/ffmpeg-devel.asc
printf '%s  source.tar.xz\n' "$digest" | sha256sum --check --strict
gpg --batch --import release-key.asc
# Verify both the expected identity and the detached signature. No keyserver trust.
gpg --batch --with-colons --fingerprint "$fingerprint" | grep -F "fpr:::::::::$fingerprint:"
gpg --batch --status-fd 1 --verify source.tar.xz.asc source.tar.xz > signature-status
grep -F "[GNUPG:] VALIDSIG $fingerprint " signature-status
cp source.tar.xz "$record/sources/ffmpeg-$version.tar.xz"
cp source.tar.xz.asc "$record/sources/ffmpeg-$version.tar.xz.asc"
cp release-key.asc "$record/sources/ffmpeg-release-key.asc"
tar -xf source.tar.xz
cd "ffmpeg-$version"

# Keep the native media formats, paired tools and application-used filters.
# External decoders below preserve common catalogue formats. Build tools and
# development headers never enter the runtime stage.
set -- --prefix="$root" --disable-debug --disable-doc --disable-ffplay \
    --disable-shared --enable-static --enable-gpl --disable-autodetect \
    --enable-gnutls --enable-libx264 --enable-libx265 --enable-libaom \
    --enable-libdav1d --enable-libvpx --enable-libopus --enable-libvorbis \
    --enable-libtheora --enable-libmp3lame --enable-libspeex \
    --enable-libopenjpeg --enable-libwebp --enable-libass \
    --enable-libfontconfig --enable-libfreetype --enable-libfribidi \
    --enable-libharfbuzz --enable-libsoxr --enable-libxml2 \
    --enable-libcodec2 --enable-libgme --enable-libgsm --enable-libopenmpt \
    --enable-libjxl --disable-librsvg --disable-decoder=librsvg \
    --enable-libsnappy --enable-libzvbi \
    --enable-libbluray \
    --enable-zlib --enable-bzlib --enable-iconv --enable-network \
    --enable-vaapi --enable-libdrm --enable-ffnvcodec --enable-nvenc \
    --enable-nvdec --enable-cuvid --enable-cuda-llvm
if [ "${TARGETARCH:?}" = amd64 ]; then
    set -- "$@" --enable-libvpl
fi
./configure "$@"
cp ffbuild/config.log "$record/ffmpeg-config.log"
cp config.h "$record/ffmpeg-config.h"
cp COPYING.GPLv2 "$record/COPYING.FFmpeg"
cp COPYING.LGPLv2.1 "$record/COPYING.LGPLv2.1"
printf 'version=%s\nsource_sha256=%s\nsigning_fingerprint=%s\narchitecture=%s\n' \
    "$version" "$digest" "$fingerprint" "$TARGETARCH" > "$record/ffmpeg-source.txt"
printf '%s\n' "$@" > "$record/configure-arguments.txt"
make -j "${BUILD_JOBS:-4}"
make install
dpkg-query -W > "$record/build-packages.txt"
"$root/bin/ffmpeg" -version > "$record/ffmpeg-version.txt"
"$root/bin/ffprobe" -version > "$record/ffprobe-version.txt"
