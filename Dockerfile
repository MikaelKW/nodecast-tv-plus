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
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
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

FROM ubuntu:24.04 AS runtime

# RUNTIME_REFRESH is set uniquely by CI and release workflows so the final
# operating-system package layer cannot be reused from an older build.
ARG TARGETARCH
ARG RUNTIME_REFRESH=manual
ENV DEBIAN_FRONTEND=noninteractive
RUN echo "Refreshing runtime packages for ${RUNTIME_REFRESH}" \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        DRIVERS="mesa-va-drivers intel-media-va-driver vainfo"; \
    else \
        DRIVERS=""; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    ffmpeg \
    python3 \
    $DRIVERS \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf \
        /usr/lib/node_modules/npm \
        /usr/lib/node_modules/corepack \
        /usr/bin/npm \
        /usr/bin/npx \
        /usr/bin/corepack \
        /var/lib/apt/lists/* \
    && apt-get clean

# Verify FFmpeg installed
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

WORKDIR /app

# Copy only the compiled production dependency tree from the builder stage.
COPY --from=dependency-builder /app/node_modules ./node_modules

# Copy application files
COPY . .

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache

# Expose port
EXPOSE 3000

# Confirm that the application and its local data stores are ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3000}${NODECAST_BASE_PATH:-}/api/health" || exit 1

# Start server
CMD ["node", "server/index.js"]
