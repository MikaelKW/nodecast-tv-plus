<p align="center">
  <img src="public/img/logo-banner.png" alt="NodeCast TV Plus" height="80" />
</p>

<p align="center">
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/actions/workflows/ci.yml"><img src="https://github.com/MikaelKW/nodecast-tv-plus/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/releases"><img src="https://img.shields.io/github/v/release/MikaelKW/nodecast-tv-plus?display_name=tag" alt="Latest release" /></a>
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/pkgs/container/nodecast-tv-plus"><img src="https://img.shields.io/badge/GHCR-nodecast--tv--plus-2496ED?logo=docker&logoColor=white" alt="GitHub Container Registry" /></a>
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license" /></a>
</p>

# NodeCast TV Plus

NodeCast TV Plus is an independent fork of [NodeCast TV](https://github.com/technomancer702/nodecast-tv), focused on additional features, usability improvements, and reliability fixes. It is a modern, web-based IPTV player featuring Live TV, EPG, Movies (VOD), and Series support.

NodeCast TV Plus is a player only: it does not include, sell, or provide television channels or other media. Use it only with sources you are legally entitled to access.

Release history and upgrade details are available in the [changelog](CHANGELOG.md). Stable, immutable versions are published on the [Releases](https://github.com/MikaelKW/nodecast-tv-plus/releases) page.

## Features

- **📺 Live TV**: Fast channel zapping, category grouping, and search.
- **📅 TV Guide (EPG)**: Interactive grid guide with 24h timeline, search, and dynamic resizing.
- **🎬 VOD Support**: Dedicated sections for Movies and TV Series with rich metadata, posters, and seasonal episode lists.
- **❤️ Favorites System**: Unified favorites for channels, movies, and series with instant synchronization.
- **🔐 Authentication**: User login system with admin and viewer roles.
- **🆔 OIDC SSO**: Support for Single Sign-On via OIDC providers (Authentik, Keycloak, etc.).
- **⚡ High Performance**: Optimized for large playlists (7000+ channels) using virtual scrolling and batch rendering.
- **⚙️ Management**: 
  - Support for Xtream Codes and M3U playlists.
  - Manage hidden content categories.
  - Playback preferences (volume memory, auto-play).
- **🎛️ Hardware Transcoding**: GPU-accelerated transcoding with NVIDIA NVENC, AMD AMF, Intel QuickSync, and VAAPI support.
- **🔊 Smart Audio**: Configurable 5.1→Stereo downmix presets (ITU, Night Mode, Cinematic) with automatic passthrough for compatible sources.
- **📦 Stream Processing**: Auto-detection of stream codecs with smart remux/transcode decisions.
- **🐳 Docker Ready**: Easy deployment containerization.

## Screenshots

> These screenshots were inherited from the upstream NodeCast TV project and will be replaced as the NodeCast TV Plus interface evolves.

<div align="center">
  <img src="public/img/screenshots/screenshot-dashboard.png" width="45%" alt="Dashboard" />
  <img src="public/img/screenshots/screenshot-1.png" width="45%" alt="Live TV" />
  <img src="public/img/screenshots/screenshot-2.png" width="45%" alt="TV Guide" />
  <img src="public/img/screenshots/screenshot-3.png" width="45%" alt="Movies" />
  <img src="public/img/screenshots/screenshot-4.png" width="45%" alt="Series" />
  <img src="public/img/screenshots/screenshot-settings.png" width="45%" alt="Settings" />
</div>

## Getting Started

### Recommended: run the published container

The official container supports `linux/amd64` and `linux/arm64` and is published at
[`ghcr.io/mikaelkw/nodecast-tv-plus`](https://github.com/MikaelKW/nodecast-tv-plus/pkgs/container/nodecast-tv-plus).

1. Create a directory for the deployment and download [`.env.example`](.env.example) as `.env`:

   ```bash
   mkdir nodecast-tv-plus && cd nodecast-tv-plus
   curl -fsSL https://raw.githubusercontent.com/MikaelKW/nodecast-tv-plus/main/.env.example -o .env
   ```

   You can also download and rename the file manually.

2. Generate two different secrets. This Docker-only command can be run twice:

   ```bash
   docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Put one value in `JWT_SECRET` and the other in `SESSION_SECRET`. Never commit the resulting `.env` file.

   To allow local accounts to enable authenticator-app two-factor authentication, run the command a third time and put that independent value in `TOTP_ENCRYPTION_KEY`. Preserve this value across upgrades and include the `.env` file in a secure deployment backup. Changing or losing it makes existing TOTP enrollments unusable.

3. Start the application:

   ```bash
   docker run -d \
     --name nodecast-tv-plus \
     --restart unless-stopped \
     --env-file .env \
     -p 3000:3000 \
     -v nodecast-tv-plus-data:/app/data \
     ghcr.io/mikaelkw/nodecast-tv-plus:2.3.0
   ```

4. Open `http://localhost:3000` and create the initial administrator account. Usernames retain their chosen capitalization for display but are case-insensitive when signing in. If an older installation already contains names that differ only by capitalization, those accounts continue to require their exact spelling until an administrator renames them uniquely.

The versioned tag is recommended for predictable deployments. The `latest` tag follows the newest stable release. To update later, pull the intended version and recreate the container while keeping the same data volume and `.env` file.

For sources that need more time to begin transcoding, set `TRANSCODE_START_TIMEOUT_SECONDS` in `.env`. It defaults to `15` and accepts a whole number from `1` to `300`. The value applies to each startup attempt; because one retry may occur after an initial provider rejection, the total wait can be approximately twice the configured value.

### Migrate from upstream NodeCast TV

NodeCast TV Plus 2.3.0 has verified migration paths from these versions:

| Existing installation | Target | Status |
| --- | --- | --- |
| Upstream v2.1.1 (last formal upstream release) | NodeCast TV Plus 2.3.0 | Verified by automated release gate |
| Upstream 2.1.4 (current upstream container and source version when tested) | NodeCast TV Plus 2.3.0 | Verified by automated release gate |
| NodeCast TV Plus 2.2.2 (previous stable Plus release) | NodeCast TV Plus 2.3.0 | Verified by automated release gate using the published image |

The migration tests reuse each baseline's `/app/data` volume and verify the administrator account and password, source configuration and provider credential fields, application settings, categories, playlist items, favorites, watch history, hidden channels, and authentication state. Upstream baselines additionally verify migration from a valid legacy bearer token to the Plus authentication cookie.

Migration support is version-specific. A future upstream or Plus version is not automatically supported merely because an earlier version was compatible. The automated gate covers both supported upstream baselines and upgrades a disposable persistent data volume from the published 2.2.2 image to the 2.3.0 release candidate. Any incompatible migration will be called out in the release notes and accompanied by migration instructions or a conversion tool when practical.

Before migrating:

1. Stop the upstream container and back up its complete `/app/data` directory or Docker volume.
2. Identify the storage currently mounted at `/app/data`:

   ```bash
   docker inspect nodecast-tv --format '{{range .Mounts}}{{println .Type .Name .Source "->" .Destination}}{{end}}'
   ```

3. Create a Plus `.env` file from [`.env.example`](.env.example). Set two different strong values for `JWT_SECRET` and `SESSION_SECRET`. Optionally set and preserve a third independent `TOTP_ENCRYPTION_KEY` to make authenticator-app 2FA available to local accounts.
4. Start the Plus container with the **existing upstream storage** mounted at `/app/data`. Do not start it with a new empty volume.

For an existing named volume, keep its actual name in the `-v` argument:

```bash
docker run -d \
  --name nodecast-tv-plus \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  -v EXISTING_UPSTREAM_VOLUME:/app/data \
  ghcr.io/mikaelkw/nodecast-tv-plus:2.3.0
```

For an existing bind-mounted directory, mount its absolute path instead:

```bash
-v /absolute/path/to/existing/data:/app/data
```

Important limitations:

- Plus requires strong `JWT_SECRET` and `SESSION_SECRET` values in production. If the upstream installation used its built-in JWT secret, create a new strong value and sign in again after migration. The saved account and password are preserved.
- Keeping the same valid `JWT_SECRET` allows an existing upstream browser token to be exchanged for the safer Plus authentication cookie. Never weaken or reuse an exposed secret solely to preserve a browser session.
- Browser-only preferences do not follow automatically when the hostname, protocol, or port changes. Server-side users, sources, settings, favorites, and history remain in `/app/data`.
- Custom plugins, reverse-proxy settings, SSO/OIDC environment variables, hardware-device mappings, and other configuration outside `/app/data` must be reviewed and migrated separately.
- Downgrades are not guaranteed. To roll back safely, stop Plus and restore the backup made before migration rather than attaching a Plus-modified data volume to an older upstream container.

After startup, confirm that login, sources, favorites, history, and playback work before removing the backup or old container.

### Build and run from source

#### Prerequisites

- Node.js 18 or higher (Node.js 20 recommended)
- npm

#### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/MikaelKW/nodecast-tv-plus.git
    cd nodecast-tv-plus
    ```

2.  Install dependencies:
    ```bash
    npm ci
    ```

3.  Start the development server:
    ```bash
    npm run dev
    ```

4.  Open your browser at `http://localhost:3000`.

### Testing changes

The project includes several complementary checks:

```bash
npm test                 # syntax, security, and server smoke tests
npm run test:e2e         # isolated browser, M3U, EPG, API, and playback test
npm run test:e2e:mobile  # iPhone/WebKit layout and scrolling regression test
npm run test:e2e:subpath # login, API, navigation, and logout below /nodecast/
npm run test:real-world  # imports the public IPTV-org sports playlist
npm run test:migration   # upgrades pinned upstream Docker baselines into the local image
```

The end-to-end and real-world tests use disposable data under `.test-data/`; they do not read or change the normal `data/` directory. The browser test generates its own short test video locally. The real-world test requires internet access and is run manually rather than in CI so an external outage cannot block every pull request.

The migration test requires Docker. It builds lightweight test containers from the exact supported upstream commits, pulls the published previous stable Plus image, generates temporary secrets and test records, upgrades each disposable data volume into the local Plus image, and removes the test containers, volumes, and baseline images afterward. The lightweight upstream baselines run the real upstream application and database code but omit media packages that are irrelevant to data migration. CI runs this release gate for pull requests targeting `main` and for manual workflow runs, ensuring migration compatibility is checked before main without slowing every feature pull request.

### Docker Compose for local builds

The included [`docker-compose.yml`](docker-compose.yml) builds the image from the current local checkout. This is useful when developing or testing code changes; ordinary installations should use the published container above.

1.  Create a `docker-compose.yml` file (or copy the one from this repo):

    Copy `.env.example` to `.env`, then generate two different random secrets. For example:

    ```bash
    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
    ```

    Run the command twice and place one value in `JWT_SECRET` and the other in `SESSION_SECRET`. Run it a third time and set `TOTP_ENCRYPTION_KEY` if local accounts should be able to enable authenticator-app 2FA. The `.env` file is ignored by Git and must never be committed.

    ```yaml
    services:
      nodecast-tv-plus:
        build: .
        container_name: nodecast-tv-plus
        ports:
          - "3000:3000" # Host:Container
        volumes:
          - ./data:/app/data
        restart: unless-stopped
        environment:
          NODE_ENV: production
          PORT: 3000 # Optional: Internal container port
          JWT_SECRET: ${JWT_SECRET:?Set JWT_SECRET in .env}
          SESSION_SECRET: ${SESSION_SECRET:?Set SESSION_SECRET in .env}
          TOTP_ENCRYPTION_KEY: ${TOTP_ENCRYPTION_KEY:-}
          NODECAST_BASE_PATH: ${NODECAST_BASE_PATH:-}
          TRANSCODE_START_TIMEOUT_SECONDS: ${TRANSCODE_START_TIMEOUT_SECONDS:-15}
    ```

2.  Build and run the container:
    ```bash
    docker compose up -d --build
    ```

The application will be available at `http://localhost:3000`.

### Container platforms

Published images are built for:

- `linux/amd64` — standard Intel/AMD 64-bit systems
- `linux/arm64` — 64-bit ARM systems

Hardware-accelerated transcoding still depends on compatible host hardware, drivers, and container device access.


### Hardware Acceleration Setup

To enable hardware transcoding (NVENC, QSV, VAAPI), you must expose your host's GPU to the container.

**1. Intel (QSV) & AMD (VAAPI)**
Update your `docker-compose.yml` to map the DRI devices and add necessary groups (often required for permission):
```yaml
    devices:
      - /dev/dri:/dev/dri # Required for VAAPI/QuickSync/AMF (Linux)
    # group_add:       # Optional: Needed mainly if you run as non-root
    #   - "video"      # Run on host: getent group video
    #   - "render"     # Run on host: getent group render
```

**2. NVIDIA (NVENC)**
Ensure you have the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed on your host, then update your `docker-compose.yml`:
```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu, utility, video, compute]
```

**Verify:**
After restarting the container, go to **Settings -> Transcoding**. The **Hardware Detection** status should list your GPU (e.g., "NVIDIA GPU Detected" or "VAAPI Available").

### SSO / OIDC Setup

Enable Single Sign-On (SSO) with your preferred OIDC provider (Authentik, Keycloak, etc.) by configuring these variables in your `.env` file or Docker environment:

```env
OIDC_ISSUER_URL=https://your-idp.com/application/o/nodecast/
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret
OIDC_CALLBACK_URL=http://localhost:3000/api/auth/oidc/callback # Adjust for your domain
```

NodeCast TV Plus retrieves the provider endpoints from
`OIDC_ISSUER_URL/.well-known/openid-configuration`, so standards-compliant
providers such as Authentik and Keycloak do not require provider-specific URL
paths. OIDC URLs must use HTTPS except when testing through localhost.

If discovery is unavailable in a special deployment, the individual endpoints
can be overridden explicitly:

```env
OIDC_AUTH_URL=https://your-idp.com/authorize
OIDC_TOKEN_URL=https://your-idp.com/token
OIDC_USERINFO_URL=https://your-idp.com/userinfo
```

**Note:** New users signing in via SSO are automatically assigned the **Viewer** role. You must manually promote them to Admin if desired.

### Two-factor authentication

Local accounts can enable standards-based TOTP from the username-initial menu under **Account security** after `TOTP_ENCRYPTION_KEY` is configured. The guided setup works with standard authenticator apps, and sign-in can use either a current six-digit code or one of the single-use recovery codes created during enrollment.

The TOTP secret is encrypted in `/app/data/db.json`; recovery codes are stored only as keyed hashes. The QR code, manual setup key, and plaintext recovery codes are shown only during the relevant setup step. Save recovery codes securely before leaving that screen.

Important operational notes:

- Keep `TOTP_ENCRYPTION_KEY` stable and back it up separately from `/app/data`. Both are needed to restore existing 2FA enrollments.
- Use a different random value from `JWT_SECRET` and `SESSION_SECRET`.
- Local administrators can reset 2FA for another account after re-entering their own password and, when enabled, their own second factor. The reset cannot reveal the other account's secret or recovery codes.
- SSO accounts continue to use the identity provider's authentication and MFA policy.

### Usage

1.  Go to **Settings** -> **Content Sources**.
2.  Add your IPTV provider details (Xtream Codes or M3U URL).
3.  Click "Refresh Sources".
4.  Navigate to **Live TV**, **Movies**, or **Series** to browse your content.


## Browser Codec Support & Transcoding

NodeCast TV Plus is a web-based application. By default, **video decoding is handled by your browser**. However, the built-in **smart transcoding system** automatically converts incompatible media (e.g., HEVC video, Dolby audio) into browser-friendly formats using FFmpeg.

**Codec Compatibility Table:**

| Codec | Chrome | Firefox | Safari | Edge |
|-------|--------|---------|--------|------|
| **H.264 (AVC)** | ✅ | ✅ | ✅ | ✅ |
| **H.265 (HEVC)** | Auto-Transcode | Auto-Transcode | ✅ | ⚠️ |
| **AV1** | ✅ | ✅ | Auto-Transcode | ✅ |
| **AAC Audio** | ✅ | ✅ | ✅ | ✅ |
| **AC3/EAC3 (Dolby)** | Auto-Transcode | Auto-Transcode | ✅ | Auto-Transcode |

> **⚠️ Note:** Edge requires the [HEVC Video Extensions](https://apps.microsoft.com/store/detail/hevc-video-extensions/9NMZLZ57R3T7) from the Microsoft Store to play H.265 (HEVC) natively.
> **ℹ️ Note:** Safari plays AV1 natively on supported hardware (iPhone 15 Pro, M3 Macs). On older devices, Auto-Transcode handles it.



## Supported Stream Types

NodeCast TV Plus is optimized for **HLS (HTTP Live Streaming)**.

-   **✅ HLS (`.m3u8`)**: Fully supported and recommended. Best for adaptive bitrate and network resilience.
-   **✅ MPEG-TS (`.ts`)**: Supported via Force Remux in settings.
-   **⚠️ High Latency/P2P**: For sources like Acestream, prefer HLS output (`.m3u8`) over raw TS streams to avoid timeouts during buffering.
-   **❌ RTMP/RTSP**: Not supported natively by browsers.

## Transcoding Settings

All transcoding and stream processing settings are found in **Settings → Transcoding**.

### Hardware Encoder

| Setting | Options | Description |
|---------|---------|-------------|
| **Hardware Encoder** | Auto, NVENC, AMF, QSV, VAAPI, Software | GPU-accelerated encoding. Auto detects best available. |
| **Max Resolution** | 4K, 1080p, 720p, 480p | Limit output resolution (lower = faster). |
| **Quality Preset** | High, Medium, Low | Encoding quality/speed tradeoff. |
| **Audio Mix Preset** | Auto, ITU, Night Mode, Cinematic, Passthrough | 5.1→Stereo downmix mode (see below). |

### Audio Mix Presets

| Preset | Description |
|--------|-------------|
| **Auto (Smart)** | Copies stereo AAC as-is, uses ITU downmix for 5.1+ |
| **ITU-R BS.775** | Industry-standard balanced downmix |
| **Night Mode** | Boosted dialogue, reduced bass for quiet viewing |
| **Cinematic** | Wide soundstage, immersive surround feel |
| **Passthrough** | No processing (may cause errors on 5.1/Dolby sources) |

### Stream Processing

| Setting | What It Does | When to Enable |
|---------|--------------|----------------|
| **Auto Transcode (Smart)** | Probes streams and only transcodes/remuxes when needed | Recommended for most users (default ON) |
| **Force Audio Transcode** | Transcodes audio to AAC (video passes through) | When you have video but no audio (Dolby/AC3/EAC3) |
| **Force Video Transcode** | Full transcode of both audio and video | For HEVC/VP9 sources on unsupported browsers |
| **Force Remux** | Remuxes MPEG-TS to MP4 (no re-encoding) | For raw `.ts` streams from middleware |
| **Stream Output Format** | HLS or TS for Xtream API requests | Try TS if HLS causes buffering |

### Network

| Setting | What It Does | When to Enable |
|---------|--------------|----------------|
| **Force Backend Proxy** | Routes streams through the server for CORS headers | When streams fail with CORS errors, or using middleware |


## Troubleshooting

### Video Won't Play (Black Screen or Loading Forever)

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Black screen, `Access-Control-Allow-Origin` error | CORS blocked | Enable **"Force Backend Proxy"** in Settings → Transcoding |
| Black screen with `MEDIA_ERR_DECODE` | Unsupported codec (HEVC/VP9) | Ensure **"Auto Transcode"** is enabled |
| Loading forever (no error) | Browser decoder stuck | Enable **"Force Video Transcode"** (overrides Auto detection) |

### No Audio (Video Plays Fine)

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| No audio at all | Dolby/AC3/EAC3 audio | Enable **"Force Audio Transcode"** (overrides Auto detection) |
| Audio out of sync | Stream encoding issue | Try changing stream format to TS in Settings |

### Buffering Issues

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Constant buffering | Slow network or weak GPU | 1. Lower **Max Resolution** (e.g. to 720p)<br>2. Try **TS** format instead of HLS |

### HTTPS / Reverse Proxy Issues

If you're running NodeCast TV Plus behind a reverse proxy (Nginx, Caddy, Traefik) with HTTPS:

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Streams fail with `fragLoadError` | Mixed content (HTTPS page loading HTTP streams) | Enable **"Force Backend Proxy"** in Settings → Transcoding |
| Streams work on HTTP but not HTTPS | Reverse proxy not passing headers correctly | Ensure `X-Forwarded-Proto` header is set (see examples below) |

**Caddy example:**
```
tv.domain.com {
    reverse_proxy nodecast:3000 {
        flush_interval -1
        header_up X-Forwarded-Proto {scheme}
    }
}
```

To publish the application below a path such as
`https://tv.domain.com/nodecast/`, set `NODECAST_BASE_PATH=/nodecast` and use
a path-stripping proxy. Keep the trailing-slash redirect so relative browser
assets resolve correctly:

```caddy
tv.domain.com {
    redir /nodecast /nodecast/ 308

    handle_path /nodecast/* {
        reverse_proxy nodecast:3000 {
            flush_interval -1
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Prefix /nodecast
        }
    }
}
```

The configured path applies to login, API, image, playback, transcoding, and
logout URLs. If SSO is enabled, register the complete public callback URL with
the identity provider, for example
`https://tv.domain.com/nodecast/api/auth/oidc/callback`, and set the same value
in `OIDC_CALLBACK_URL`.

**Nginx example:**
```nginx
location / {
    proxy_pass http://nodecast:3000;
    proxy_http_version 1.1;           # Required for chunked transfers and keep-alive
    proxy_buffering off;              # Don't buffer responses (required for streaming)
    proxy_request_buffering off;      # Don't buffer requests
    proxy_read_timeout 300s;          # VOD: 5 min timeout for large files
    proxy_connect_timeout 60s;        # VOD: Connection timeout
    client_max_body_size 0;           # No upload size limit
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;  # Required for HTTPS detection
    proxy_set_header Connection "";   # VOD: Enable keep-alive for Range requests
}
```

### IPTV Middleware (m3u-editor, dispatcharr, Threadfin, xTeVe)
If you manage your streams with middleware tools, you may encounter CORS issues or raw MPEG-TS streams that browsers can't play directly.

**Recommended Setup:**
1.  **Force Backend Proxy:** Enable this in **Settings → Transcoding → Network**. This routes middleware streams through NodeCast TV Plus, bypassing CORS restrictions.
2.  **Auto Transcode:** Keep this enabled (default). It will automatically detect if the middleware stream (e.g., MPEG-TS) needs to be remuxed or transcoded for the browser.

There is rarely a need to configure specific "Force Remux" settings manually anymore; the system detects stream types automatically.

### TVHeadend

If you're using TVHeadend as your source, you may need to configure a few settings for streams to play correctly in NodeCast TV Plus:

**Option 1: Enable Force Backend Proxy (Easiest)**
- In NodeCast TV Plus, go to **Settings → Transcoding → Network**
- Enable **"Force Backend Proxy"**
- This routes streams through the server, bypassing browser CORS restrictions

**Option 2: Configure TVHeadend CORS**
- In TVHeadend, go to **Configuration → General → Base → HTTP Server Settings**
- Add your NodeCast TV Plus URL to **"CORS origin"** (e.g., `http://192.168.1.100:3000`)
- **Note:** You must include the protocol (`http://` or `https://`)

**Additional Tips:**
- Enable **"digest+plain"** authentication in TVHeadend if using username/password in the M3U URL
- Try different stream profiles (`?profile=pass` or `?profile=matroska`) if playback issues persist

### Acestream / P2P Streaming

If you are using `acestream-docker-home` or similar tools, it is **recommended** to use the HLS output format to reduce server load, though NodeCast TV Plus can remux raw streams if needed.

-   **Recommended:** `http://proxy:6878/ace/manifest.m3u8?id=...` (HLS Playlist - Direct Play)
-   **Supported:** `http://proxy:6878/ace/getstream?id=...` (MPEG-TS - Requires Server Remuxing)

## Technology Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JavaScript (ES6+), CSS3
- **Database**: SQLite (via better-sqlite3) for high-performance data storage
- **Streaming**: HLS.js for stream playback
- **Transcoding**: FFmpeg (integrated for hardware/software transcoding)

## Project Structure

```
nodecast-tv-plus/
├── public/              # Frontend assets
│   ├── css/             # Stylesheets
│   ├── js/              # Client-side logic
│   │   ├── components/  # UI Components (ChannelList, EpgGuide, etc.)
│   │   ├── pages/       # Page Controllers (Movies, Series, etc.)
│   │   └── api.js       # API Client
│   └── index.html       # Main entry point
├── server/              # Backend server
│   ├── config/          # Runtime and security configuration
│   ├── routes/          # API endpoints
│   ├── services/        # Playlist, OIDC, hardware, and transcode services
│   ├── db.js            # Application data access layer
│   ├── db/sqlite.js     # SQLite connection and schema
│   └── index.js         # Server Entry Point
├── scripts/             # Automated checks and maintenance scripts
├── tests/               # Browser fixtures and integration tests
└── data/                # Persistent storage (content.db, playlists)
```

## Support and contributing

- [Report a bug](https://github.com/MikaelKW/nodecast-tv-plus/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/MikaelKW/nodecast-tv-plus/issues/new?template=feature_request.md)
- [View open issues](https://github.com/MikaelKW/nodecast-tv-plus/issues)
- [View pull requests](https://github.com/MikaelKW/nodecast-tv-plus/pulls)

Code changes should normally target the `develop` branch and pass the repository's automated checks before promotion to `testing` and `main`.

When reporting problems, redact provider credentials, private playlist URLs, tokens, cookies, and other sensitive information from screenshots and logs.

## License

NodeCast TV Plus is distributed under the **GNU General Public License v3.0 only (`GPL-3.0-only`)**. See the authoritative [LICENSE](https://github.com/MikaelKW/nodecast-tv-plus/blob/main/LICENSE) file for the complete terms.
