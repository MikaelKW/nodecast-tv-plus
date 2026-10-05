# NodeCast TV Plus Docker Image
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...

FROM ubuntu:24.04 AS dependency-builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app

COPY package*.json ./

# Build native production dependencies without retaining the toolchain later.
RUN npm ci --omit=dev

FROM ubuntu:24.04 AS media-build-packages

ARG TARGETARCH
ARG RUNTIME_REFRESH=manual
ENV DEBIAN_FRONTEND=noninteractive
RUN echo "Refreshing media build packages for ${RUNTIME_REFRESH}" \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg build-essential pkg-config nasm \
    libgnutls28-dev libx264-dev libx265-dev libaom-dev libdav1d-dev \
    libvpx-dev libopus-dev libvorbis-dev libtheora-dev libmp3lame-dev \
    libspeex-dev libopenjp2-7-dev libwebp-dev libass-dev \
    libfontconfig1-dev libfreetype-dev libfribidi-dev libharfbuzz-dev \
    libsoxr-dev libxml2-dev zlib1g-dev libbz2-dev \
    libcodec2-dev libgme-dev libgsm1-dev libopenmpt-dev libjxl-dev \
    libsnappy-dev libzvbi-dev libbluray-dev \
    libva-dev libdrm-dev libffmpeg-nvenc-dev clang \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        apt-get install -y --no-install-recommends libvpl-dev; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# Always refresh build packages, but key compilation on their actual contents.
# Ubuntu is usr-merged: /usr contains the compiler, headers and linked libraries;
# /etc and dpkg's database retain configuration and exact package provenance.
# Read-only build mounts key this step on those contents without duplicating
# the toolchain into exported layers. Copy configuration rather than mounting
# /etc so Docker can still supply its build-time resolver. Apt logs/indexes
# are not compiler inputs.
FROM ubuntu:24.04 AS media-builder
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=media-build-packages /etc/ /etc/
COPY docker/build-media.sh /tmp/build-media
COPY docker/collect-media-packages.sh /tmp/collect-media-packages
RUN --mount=type=bind,from=media-build-packages,source=/usr,target=/usr \
    --mount=type=bind,from=media-build-packages,source=/var/lib/dpkg,target=/var/lib/dpkg \
    sh /tmp/build-media && sh /tmp/collect-media-packages

FROM ubuntu:24.04 AS runtime

# RUNTIME_REFRESH is set uniquely by CI and release workflows so the final
# operating-system package layer cannot be reused from an older build.
ARG TARGETARCH
ARG RUNTIME_REFRESH=manual
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=media-builder /opt/media/share/nodecast-runtime/runtime-packages.txt /tmp/media-runtime-packages.txt
RUN echo "Refreshing runtime packages for ${RUNTIME_REFRESH}" \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        DRIVERS="mesa-va-drivers intel-media-va-driver vainfo"; \
    else \
        DRIVERS=""; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    python3 \
    $(cat /tmp/media-runtime-packages.txt) \
    $DRIVERS \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf \
        /usr/lib/node_modules/npm \
        /usr/lib/node_modules/corepack \
        /usr/bin/npm \
        /usr/bin/npx \
        /usr/bin/corepack \
        /tmp/media-runtime-packages.txt \
        /var/lib/apt/lists/* \
    && apt-get clean

# Install the paired tools and corresponding source/build records, not the
# distribution's older libav libraries or the media builder's toolchain.
COPY --from=media-builder /opt/media/bin/ffmpeg /opt/media/bin/ffprobe /usr/local/bin/
COPY --from=media-builder /opt/media/share/nodecast-runtime /usr/share/nodecast-runtime
RUN ffmpeg -version && ffprobe -version \
    && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

WORKDIR /app

# Copy only the compiled production dependency tree from the builder stage.
COPY --from=dependency-builder /app/node_modules ./node_modules

# Keep package fallback paths on the same verified tools instead of retaining
# older downloaded executables beside the system pair.
RUN node -e 'const fs=require("fs"); for(const [path,target] of [[require("ffmpeg-static"),"/usr/local/bin/ffmpeg"],[require("@ffprobe-installer/ffprobe").path,"/usr/local/bin/ffprobe"]]) { if(!path) throw new Error("Media fallback path unavailable"); fs.unlinkSync(path); fs.symlinkSync(target,path); }'

# Copy application files
COPY . .

# Expose the immutable build revision to the local diagnostics view.
ARG NODECAST_REVISION=unknown
ENV NODECAST_REVISION=${NODECAST_REVISION}

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache \
    && node scripts/container-runtime-test.js

# Expose port
EXPOSE 3000

# Confirm that the application and its local data stores are ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3000}${NODECAST_BASE_PATH:-}/api/health" || exit 1

# Start server
CMD ["node", "server/index.js"]
