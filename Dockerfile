# NodeCast TV Plus Docker Image
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...

FROM ubuntu:24.04

# Install Node.js, FFmpeg, and hardware acceleration drivers
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    make \
    g++ \
    $DRIVERS \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (better-sqlite3 will build from source using g++ installed above)
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
