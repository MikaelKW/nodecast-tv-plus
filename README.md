<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/img/logo-banner.png" />
    <source media="(prefers-color-scheme: light)" srcset="public/img/logo-banner-light.png" />
    <img src="public/img/logo-banner-light.png" alt="NodeCast TV Plus" height="80" />
  </picture>
</p>

<p align="center">
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/actions/workflows/ci.yml"><img src="https://github.com/MikaelKW/nodecast-tv-plus/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/releases"><img src="https://img.shields.io/github/v/release/MikaelKW/nodecast-tv-plus?display_name=tag" alt="Latest release" /></a>
  <a href="https://hub.docker.com/r/mikaelkw/nodecast-tv-plus"><img src="https://img.shields.io/badge/Docker%20Hub-nodecast--tv--plus-2496ED?logo=docker&logoColor=white" alt="Docker Hub" /></a>
  <a href="https://github.com/MikaelKW/nodecast-tv-plus/pkgs/container/nodecast-tv-plus"><img src="https://img.shields.io/badge/GHCR-nodecast--tv--plus-2496ED?logo=docker&logoColor=white" alt="GitHub Container Registry" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license" /></a>
</p>

# NodeCast TV Plus

NodeCast TV Plus is a modern, self-hosted IPTV player for Live TV, programme guides, movies, and series. It is an independent, enhanced fork of [NodeCast TV](https://github.com/technomancer702/nodecast-tv).

NodeCast TV Plus is a player only. It does not include, sell, or provide television channels or other media. Use it only with sources you are legally entitled to access.

## Highlights

- Live TV with categories, favorites, search, fast channel changes, and an interactive TV guide.
- Movies and series with posters, metadata, seasons, episodes, favorites, and watch progress.
- Xtream Codes, M3U playlists, and separate XMLTV/EPG sources.
- Smart direct play, remuxing, and FFmpeg transcoding for browser compatibility.
- In-player quality limits plus audio-track and subtitle selection.
- NVIDIA NVENC, AMD AMF, Intel Quick Sync, and VAAPI hardware acceleration where supported by the host.
- Local accounts with administrator/viewer roles, TOTP two-factor authentication, recovery codes, and password safeguards.
- Standards-based OIDC single sign-on with optional SSO-only mode.
- Per-source visibility controls, configurable navigation, and light/dark/system themes.
- Multi-architecture Docker images for `linux/amd64` and `linux/arm64`.

## Interface

<p align="center">
  <img src="public/img/screenshots/screenshot-dashboard.png" width="49%" alt="NodeCast TV dashboard" />
  <img src="public/img/screenshots/screenshot-2.png" width="49%" alt="NodeCast TV programme guide" />
  <img src="public/img/screenshots/screenshot-3.png" width="49%" alt="NodeCast TV movie library" />
  <img src="public/img/screenshots/screenshot-settings.png" width="49%" alt="NodeCast TV transcoding settings" />
</p>

These screenshots were inherited from upstream NodeCast TV. Some will be replaced as the NodeCast TV Plus interface and themes evolve.

## Quick start with Docker Compose

### Requirements

- Docker Engine
- Docker Compose v2 (`docker compose`)

### 1. Create `compose.yml`

The file below is an example deployment:

```yaml
services:
  nodecast-tv-plus:
    image: mikaelkw/nodecast-tv-plus:latest
    container_name: nodecast-tv-plus
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - nodecast-tv-plus-data:/app/data
    security_opt:
      - no-new-privileges:true

volumes:
  nodecast-tv-plus-data:
    name: nodecast-tv-plus-data
```

This example reads its environment variables from `.env`. An environment file is not strictly required—variables can instead be configured directly through Docker or another container platform—but it is recommended because it keeps security secrets separate from `compose.yml`.

The example uses [Docker Hub](https://hub.docker.com/r/mikaelkw/nodecast-tv-plus). The equivalent GitHub Container Registry image is `ghcr.io/mikaelkw/nodecast-tv-plus:latest`.

`latest` follows the newest stable release. For controlled upgrades, replace it with an exact version tag from the [Releases](https://github.com/MikaelKW/nodecast-tv-plus/releases) page.

### 2. Generate the security secrets

Generate three different random values:

```bash
openssl rand -hex 48
openssl rand -hex 48
openssl rand -hex 48
```

Create `.env` and paste a different generated value after each security variable:

```env
NODE_ENV=production
JWT_SECRET=replace-with-the-first-generated-value
SESSION_SECRET=replace-with-the-second-generated-value
TOTP_ENCRYPTION_KEY=replace-with-the-third-generated-value
TZ=YOUR_REGION/YOUR_CITY
```

`NODE_ENV=production` makes the container refuse to start if `JWT_SECRET` or `SESSION_SECRET` is missing or weak. This prevents a production installation from silently using temporary development secrets.

`TZ` is optional. Replace `YOUR_REGION/YOUR_CITY` with the appropriate [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), such as `America/New_York`, or remove the line if the default UTC time zone is suitable.

Restrict the file so that only its owner can read or modify it:

```bash
chmod 600 .env
```

These values protect logins, sessions, and local-account two-factor authentication. Preserve the same values across container upgrades and restores. Changing `TOTP_ENCRYPTION_KEY` makes existing TOTP enrollments unusable.

<details>
<summary><strong>Generate the complete .env file automatically with Docker</strong></summary>

If OpenSSL is unavailable, this command creates `.env` with three independent random secrets:

```bash
docker run --rm node:20-alpine node -e "const c=require('crypto'); console.log('NODE_ENV=production'); for (const n of ['JWT_SECRET','SESSION_SECRET','TOTP_ENCRYPTION_KEY']) console.log(n+'='+c.randomBytes(48).toString('hex'))" > .env
chmod 600 .env
```

Add an optional `TZ` line afterward if required.

</details>

### 3. Start NodeCast TV Plus

```bash
docker compose up -d
```

Open `http://YOUR-SERVER-IP:3000` and create the initial administrator account. Usernames retain their chosen capitalization for display but are case-insensitive when signing in. If an upstream installation migrated to this fork already contains names that differ only by capitalization, those accounts continue to require their exact spelling until an administrator renames them uniquely.

Check the container:

```bash
docker compose ps
```

When ready, the container reports `healthy`. The lightweight `/api/health` endpoint also reports application readiness without contacting IPTV providers or exposing configuration.

<details>
<summary><strong>Docker run alternative</strong></summary>

The same installation can be started without Compose:

```bash
docker run -d \
  --name nodecast-tv-plus \
  --restart unless-stopped \
  --env-file .env \
  --security-opt no-new-privileges:true \
  -p 3000:3000 \
  -v nodecast-tv-plus-data:/app/data \
  mikaelkw/nodecast-tv-plus:latest
```

Use `docker ps` to check the container and `docker logs nodecast-tv-plus` to view its logs.

</details>

## Updating

Back up the persistent data volume and `.env` file before upgrading. Then pull and recreate the container:

When using `latest`, run:

```bash
docker compose pull
docker compose up -d
```

When using an exact version tag, first change the `image` value in `compose.yml` to the intended new version, then run the same commands.

The `/app/data` volume contains users, sources, settings, favorites, and watch history. Recreating the container is safe when this volume and `.env` are preserved.

To roll back, restore the pre-upgrade data backup and use the previous image tag. Downgrading a data volume already modified by a newer release is not guaranteed.

<details>
<summary><strong>Updating a container created with Docker run</strong></summary>

Pull the intended image, stop and remove the old container, then repeat the Docker Run command from the installation section:

```bash
docker pull mikaelkw/nodecast-tv-plus:latest
docker stop nodecast-tv-plus
docker rm nodecast-tv-plus
```

The named `nodecast-tv-plus-data` volume and `.env` file are not removed by these commands. Reusing both preserves the installation.

</details>

## Configuration

Settings that are not listed below are normally managed inside the application.

### Security variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | Yes | Protects authentication tokens. Use a unique random value of at least 32 characters. |
| `SESSION_SECRET` | Yes | Protects login sessions. It must be different from `JWT_SECRET`. |
| `TOTP_ENCRYPTION_KEY` | For local-account MFA | Encrypts authenticator-app secrets. Preserve it across upgrades and restores. |

The quick-start command generates all three values securely.

### Common optional variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Not set | Set to `production` to make startup fail when `JWT_SECRET` or `SESSION_SECRET` is missing or weak instead of using temporary development secrets. Recommended as an additional production safeguard. |
| `APP_ORIGIN` | Automatic | Public origin, such as `https://tv.example.com`, when automatic reverse-proxy detection is unsuitable. |
| `AUTH_COOKIE_SECURE` | Automatic | Force secure cookies with `true`, or disable them with `false`. Normally leave unset. |
| `TZ` | `Etc/UTC` | Container time zone using an IANA name such as `Europe/Oslo`. |
| `NODECAST_BASE_PATH` | Empty | Public subpath when hosting below a path, for example `/nodecast`. |
| `NODECAST_INSTANCE_ID` | Automatic | Distinguishes cloned installations that share a hostname. Ordinary installations do not need this. |
| `ALLOW_LOCAL_MEDIA_URLS` | `false` | Allows loopback sources such as `http://127.0.0.1`. Private LAN addresses do not require it. |
| `TRANSCODE_START_TIMEOUT_SECONDS` | `15` | Seconds to wait per transcode startup attempt. Accepts `1` to `300`. |

Add optional values on new lines in `.env`, then apply them with:

```bash
docker compose up -d
```

Each installation stores a stable identifier in `/app/data`. This keeps separate NodeCast TV Plus containers on different ports of the same hostname signed in independently. When cloning an existing data volume, set a different stable `NODECAST_INSTANCE_ID` for each clone.

<details>
<summary><strong>OIDC single sign-on</strong></summary>

Add these values to `.env`:

```env
OIDC_ISSUER_URL=https://identity.example.com/application/o/nodecast/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_CALLBACK_URL=https://tv.example.com/api/auth/oidc/callback
```

NodeCast TV Plus uses the provider's standard OIDC discovery document. Authentik, Keycloak, and other standards-compliant providers do not need provider-specific endpoint configuration.

OIDC URLs must use HTTPS except when testing through localhost.

New SSO accounts receive the Viewer role. An administrator can promote them under **Settings > Users**.

To use SSO-only sign-in:

```env
DISABLE_LOCAL_AUTH=true
OIDC_AUTO_REDIRECT=true
```

Before disabling local sign-in:

1. Complete the initial local administrator setup.
2. Confirm that an SSO account can sign in.
3. Promote the intended SSO account to Administrator.
4. Back up `/app/data` and `.env`.
5. Enable SSO-only mode, restart, and verify administrator access.

If local sign-in remains enabled, `login.html?local=1` bypasses automatic SSO redirect for that visit.

For unusual providers without discovery, `OIDC_AUTH_URL`, `OIDC_TOKEN_URL`, and `OIDC_USERINFO_URL` can override the individual endpoints.

</details>

<details>
<summary><strong>Reverse proxy and subpath notes</strong></summary>

Forward the original host and protocol, allow streaming responses, and disable proxy buffering. For HTTPS deployments, enabling **Force Backend Proxy** under **Settings > Transcoding** can resolve mixed-content or provider CORS restrictions.

When publishing at a subpath such as `https://tv.example.com/nodecast/`:

```env
NODECAST_BASE_PATH=/nodecast
```

The reverse proxy must strip that prefix before forwarding requests. Preserve the trailing slash. When using SSO, register and configure the complete callback URL:

```env
OIDC_CALLBACK_URL=https://tv.example.com/nodecast/api/auth/oidc/callback
```

</details>

## Add content

1. Open **Settings > Sources**.
2. Add an Xtream Codes connection, M3U playlist, or separate EPG source.
3. Wait for the initial synchronization to finish.
4. Browse the available content under **Live TV**, **TV Guide**, **Movies**, or **Series**.

Source settings can control whether content appears in Live TV, Movies, or Series. The **Manage Content** tab controls individual groups and channels.

## Playback and transcoding

Keep **Auto Transcode (Smart)** enabled unless troubleshooting a specific provider. NodeCast TV Plus probes each stream and chooses direct playback, remuxing, audio conversion, or full transcoding as needed.

During playback:

- **Auto** uses the normal best-effort quality behavior.
- A resolution limit can be selected without leaving the player.
- Available audio and subtitle tracks can be changed for movies and episodes.
- A provider may prevent a requested quality limit; playback then returns to the original stream with a clear notice.

Common adjustments under **Settings > Transcoding**:

| Problem | Adjustment |
| --- | --- |
| Browser reports CORS or mixed-content errors | Enable **Force Backend Proxy**. |
| Video plays without audio | Enable **Force Audio Transcode**. |
| Browser cannot decode the video | Enable **Force Video Transcode**. |
| Provider startup is unusually slow | Increase `TRANSCODE_START_TIMEOUT_SECONDS` in `.env`. |
| Constant buffering | Lower the maximum resolution or quality preset, check available CPU/GPU and network capacity, and compare HLS with MPEG-TS output when the Xtream provider offers both. |

HLS is preferred. Raw MPEG-TS streams are automatically remuxed when required. RTMP and RTSP cannot be played directly by web browsers.

<details>
<summary><strong>Browser codec support and stream types</strong></summary>

Browser codec support depends on the browser, operating system, device hardware, and installed media components. NodeCast TV Plus probes streams and converts unsupported media when smart transcoding is enabled.

| Codec | Typical browser behavior |
| --- | --- |
| H.264 / AVC video | Broad native support and normally played directly. |
| H.265 / HEVC video | Native support varies; otherwise video is transcoded. |
| AV1 video | Native support varies by browser and hardware; otherwise video is transcoded. |
| AAC audio | Broad native support and normally played directly. |
| AC3 / EAC3 audio | Support varies; audio is converted to AAC when required. |

On Windows, Microsoft provides the [HEVC Video Extensions](https://apps.microsoft.com/detail/9nmzlz57r3t7) for applications and browsers that use the system's HEVC support. Native playback still depends on the browser, Windows version, hardware, and media format.

[WebKit documents AV1 support](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/#av1) in Safari on devices with AV1 hardware decoding. On other Apple devices, smart transcoding provides the compatibility fallback.

Supported input and delivery types:

| Stream type | Support |
| --- | --- |
| HLS (`.m3u8`) | Preferred for Live TV and adaptive streaming. |
| MPEG-TS (`.ts`) | Supported through automatic or forced remuxing/transcoding. |
| Progressive VOD files | Supported when the provider exposes a browser-compatible or processable media URL. |
| RTMP / RTSP | Not played directly because web browsers do not support these protocols natively. |

</details>

<details>
<summary><strong>Transcoding settings reference</strong></summary>

All stream-processing options are under **Settings > Transcoding**.

| Setting | Options | Purpose |
| --- | --- | --- |
| **Hardware Encoder** | Auto, NVENC, AMF, QSV, VAAPI, Software | Selects GPU or software encoding. Auto uses the best detected option. |
| **Max Resolution** | 4K, 1080p, 720p, 480p | Best-effort upper limit for transcoded output. Lower values reduce processing and bandwidth. |
| **Quality Preset** | High, Medium, Low | Balances picture quality against CPU/GPU work and bandwidth. |
| **Audio Mix Preset** | Auto, ITU, Night Mode, Cinematic, Passthrough | Controls how multi-channel audio is converted for browser playback. |

Audio mix presets:

| Preset | Behavior |
| --- | --- |
| **Auto (Smart)** | Copies compatible stereo AAC and uses a balanced downmix for multi-channel audio. |
| **ITU-R BS.775** | Standard balanced surround-to-stereo downmix. |
| **Night Mode** | Emphasizes dialogue and reduces loud bass or effects. |
| **Cinematic** | Preserves a wider, more spacious presentation. |
| **Passthrough** | Avoids audio processing when the browser and source are already compatible. |

Stream-processing controls:

| Setting | Purpose |
| --- | --- |
| **Auto Transcode (Smart)** | Probes each stream and chooses direct playback, remuxing, audio conversion, or full transcoding. Recommended for most installations. |
| **Force Audio Transcode** | Converts audio to AAC while preserving compatible video. Useful when video works but audio does not. |
| **Force Video Transcode** | Converts both video and audio for sources a browser cannot decode. |
| **Force Remux** | Forces a container conversion without re-encoding compatible audio/video tracks. |
| **Stream Output Format** | Chooses the HLS or MPEG-TS format requested from an Xtream provider. |
| **Force Backend Proxy** | Sends provider media through NodeCast TV Plus to handle CORS, mixed-content, or provider-access restrictions. |

</details>

<details>
<summary><strong>Hardware acceleration</strong></summary>

Hardware acceleration requires compatible host drivers and access to the GPU from the container.

For Intel Quick Sync or VAAPI devices, add this to the service in `compose.yml`:

```yaml
    devices:
      - /dev/dri:/dev/dri
```

For NVIDIA NVENC, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and add:

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu, utility, video, compute]
```

Recreate the container, then check **Settings > Transcoding** for detected hardware. Availability depends on the host, drivers, container runtime, and codecs involved.

</details>

<details>
<summary><strong>IPTV middleware, TVHeadend, and Acestream</strong></summary>

### IPTV middleware

Middleware such as Dispatcharr, Threadfin, xTeVe, or m3u-editor may expose streams without browser-compatible CORS headers or as raw MPEG-TS.

Recommended starting point:

1. Keep **Auto Transcode (Smart)** enabled.
2. Enable **Force Backend Proxy** if the browser reports CORS, HTTPS mixed-content, or provider-access errors.
3. Prefer HLS output from the middleware when it is available.

### TVHeadend

The simplest option is to enable **Force Backend Proxy** under **Settings > Transcoding**.

Alternatively, configure the NodeCast TV Plus origin in TVHeadend's CORS settings. Include the complete protocol, hostname, and port, for example `http://192.168.1.100:3000`.

If authentication fails, confirm that the M3U URL and TVHeadend authentication mode are compatible. Different TVHeadend stream profiles may also produce different browser results.

### Acestream and other P2P gateways

HLS output is recommended:

```text
http://gateway:6878/ace/manifest.m3u8?id=STREAM_ID
```

Raw MPEG-TS output can also be processed, but requires backend remuxing and may place more load on the server:

```text
http://gateway:6878/ace/getstream?id=STREAM_ID
```

Stream availability and legality depend on the configured source. NodeCast TV Plus does not provide Acestream IDs or media.

</details>

## Two-factor authentication

Local accounts can enable authenticator-app TOTP from the username menu under **Account security**. Sign-in accepts a current six-digit code or one of the single-use recovery codes created during enrollment.

Keep both `/app/data` and `TOTP_ENCRYPTION_KEY` in the deployment backup. Recovery codes are only shown during enrollment or regeneration.

SSO accounts use the identity provider's authentication and MFA policy.

## Migrating from upstream NodeCast TV

Downgrading from NodeCast TV Plus back to upstream NodeCast TV after Plus has opened the data volume is not supported. Returning to upstream requires restoring the complete backup created before migration.

The current release verifies upgrades from the last formal upstream release (`v2.1.1`), upstream internal version `2.1.4`, and the previous stable NodeCast TV Plus release. The automated release gate checks that accounts, source configuration, settings, favorites, history, hidden content, and authentication data survive the upgrade.

Before migrating:

1. Stop the old container.
2. Back up the complete storage currently mounted at `/app/data`.
3. Create `compose.yml` and `.env` as described above.
4. Mount the **existing** upstream storage at `/app/data` instead of creating an empty volume.
5. Start NodeCast TV Plus and verify login, sources, favorites, history, and playback before removing the backup.

Migration support is version-specific. Future upstream or Plus versions are not assumed compatible until they pass the release gate. Configuration stored outside `/app/data`, including reverse-proxy, OIDC, device mappings, and custom integrations, must be migrated separately.

See the [changelog](https://github.com/MikaelKW/nodecast-tv-plus/blob/main/CHANGELOG.md) and [release notes](https://github.com/MikaelKW/nodecast-tv-plus/releases) for version-specific upgrade information.

## Troubleshooting

### Container does not become healthy

```bash
docker compose ps
docker compose logs --tail=200 nodecast-tv-plus
```

Confirm that `JWT_SECRET` and `SESSION_SECRET` are supplied through `.env`, the `environment` section of `compose.yml`, or the container platform, and that port `3000` is not already in use. `TOTP_ENCRYPTION_KEY` is additionally required when local accounts use authenticator-app MFA.

### Provider or playback problem

Test another known-working channel first, then review **Settings > Transcoding**. Provider outages, expired credentials, unsupported codecs, CORS restrictions, and insufficient transcoding resources can look similar in the player.

When reporting a problem, redact provider URLs, credentials, query tokens, and cookies from logs and screenshots.

### Preserve data before experimenting

Do not remove or replace the `/app/data` volume while troubleshooting. Make a backup before changing image versions or migration settings.

## Development and contributing

The normal Docker installation above uses a published image and does **not** build source code locally.

Source development requires Node.js 18 or newer; Node.js 20 is recommended.

For development:

```bash
git clone https://github.com/MikaelKW/nodecast-tv-plus.git
cd nodecast-tv-plus
npm ci
npm run dev
```

The repository's `docker-compose.yml` is intended for contributors who need to build an image from their current source checkout. This is what “local build” means; ordinary installations do not need `docker compose up -d --build`.

Useful checks:

```bash
npm test                 # syntax, security, and server smoke tests
npm run test:e2e         # isolated browser, M3U, EPG, API, and playback tests
npm run test:e2e:mobile  # iPhone/WebKit layout and scrolling regression tests
npm run test:e2e:subpath # login, API, navigation, and logout below /nodecast/
npm run test:migration   # upgrades pinned upstream Docker baselines into the local image
```

Code changes normally target `develop` and pass automated and hands-on testing before promotion to `testing` and `main`.

## Security

Do not report suspected security vulnerabilities through the public issue tracker. Review the [security policy](SECURITY.md), then use GitHub's [private vulnerability reporting form](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/new) so the report can be investigated before technical details are disclosed.

## Project links

- [Releases](https://github.com/MikaelKW/nodecast-tv-plus/releases)
- [Changelog](https://github.com/MikaelKW/nodecast-tv-plus/blob/main/CHANGELOG.md)
- [Roadmap](https://github.com/users/MikaelKW/projects/1)
- [Report a bug](https://github.com/MikaelKW/nodecast-tv-plus/issues/new?template=bug_report.md)
- [Request a feature](https://github.com/MikaelKW/nodecast-tv-plus/issues/new?template=feature_request.md)
- [Report a security vulnerability](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/new)
- [Security policy](SECURITY.md)
- [Open issues](https://github.com/MikaelKW/nodecast-tv-plus/issues)
- [Pull requests](https://github.com/MikaelKW/nodecast-tv-plus/pulls)

## License

NodeCast TV Plus is distributed under the [GNU General Public License v3.0 only](LICENSE).
