# Changelog

All notable changes to NodeCast TV Plus are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Historical notes below distinguish upstream development from formal NodeCast TV Plus releases.

## [2.5.1] - 2026-07-29

This patch release improves compatibility with AAC audio in MPEG-TS live streams, reduces startup and guide-loading work for large providers, and strengthens media, network, cache, session, and authentication boundaries.

### Changed

- Load lightweight current-programme data first, fetch the full TV guide only when requested, and process independent provider sources concurrently so large installations become usable sooner ([#261]).
- Bound transient source retries, defer hidden-tab refresh work, and add database indexes and response compression for large channel and EPG catalogues ([#261]).
- Pin third-party GitHub Actions to reviewed commit identifiers and keep release validation aligned across GHCR and Docker Hub.

### Fixed

- Apply FFmpeg's AAC ADTS-to-ASC conversion when remuxing compatible AAC-in-MPEG-TS streams to fragmented MP4, without unnecessarily re-encoding audio ([#258]).
- Retry an Xtream live channel with MPEG-TS output when that channel's HLS response is incompatible, while keeping the fallback isolated to the affected channel ([#258]).
- Keep later provider sources available when an earlier source fails or times out during startup ([#261]).

### Security

- Tightened media-proxy and playback destination validation, including redirect checks and restrictions around local or otherwise unintended network targets. [GHSA-fvg4-p7ph-7pcf](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/GHSA-fvg4-p7ph-7pcf)
- Strengthened cache-directory containment so administrative cleanup remains confined to application cache storage. [GHSA-r779-m9mv-pjqf](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/GHSA-r779-m9mv-pjqf)
- Strengthened transcode-segment path containment so authenticated requests remain confined to their intended session directory. [GHSA-93v6-vvxj-2f97](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/GHSA-93v6-vvxj-2f97)
- Restricted proxy-trust handling and strengthened account- and challenge-bound TOTP attempt limits. [GHSA-6m25-cj9x-gf5p](https://github.com/MikaelKW/nodecast-tv-plus/security/advisories/GHSA-6m25-cj9x-gf5p)
- Added media-process limits and strengthened session lifecycle controls.

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.5.1`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values. Preserve `TOTP_ENCRYPTION_KEY` when authenticator-app 2FA is in use.
- No manual database migration is required. Migration from the published 2.5.0 container is covered by the automated release gate; supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Stable images are available from both `ghcr.io/mikaelkw/nodecast-tv-plus` and `mikaelkw/nodecast-tv-plus`; GHCR remains the canonical registry.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.5.0` and the existing deployment secrets.

## [2.5.0] - 2026-07-27

This feature release adds audio-track and subtitle selection for Movies and Series, strengthens long-form VOD playback, improves mobile and cross-browser presentation, isolates authentication cookies between installations, and mirrors stable images to Docker Hub.

### Added

- Added in-player audio-track and subtitle selection for supported Movie and Series streams, including named language choices and a clear Off option for subtitles ([#213]).
- Added stable multi-architecture Docker Hub publication from the same release build as GitHub Container Registry, with aligned exact-version, compatible-minor, and `latest` tags ([#248]).

### Changed

- Embedded subtitles are extracted on demand in bounded windows for long-form VOD instead of blocking playback while processing the complete source ([#224], [#226]).
- Subtitle cues are preserved and restored across unbuffered seeks, audio changes, and replacement HLS sessions while keeping their source timing ([#221], [#230]).
- The Movie and Series scroll-for-details hint is hidden during web and native fullscreen playback ([#244]).

### Fixed

- Preserved the active VOD position when changing audio tracks instead of visually restarting the player timeline ([#216]).
- Stabilized the VOD scrubber against a growing HLS buffer and restored accurate seeking after the requested position falls outside the generated window ([#219]).
- Kept seeked audio aligned with stream-copied video and reduced Firefox playback overhead while player controls are visible ([#228]).
- Made long-form subtitle startup and far-seek recovery complete promptly without blocking the application or leaving media processes behind ([#226]).
- Corrected subtitle flicker, blank bracketed cues, overlapping-dialogue replacement, and seek-session timing across Chromium, Firefox, and iPhone Safari ([#230]).
- Made every Movie and Series card reachable in iPhone Safari portrait and landscape layouts ([#233]).
- Normalized subtitle font, responsive size, transparent cue background, outline, and placement across supported browsers while retaining native-platform fullscreen behavior ([#242]).

### Security

- Isolated JWT and session cookie names per installation so multiple NodeCast TV Plus containers on one hostname no longer overwrite or sign out each other's browser sessions ([#246]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.5.0`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values. Preserve `TOTP_ENCRYPTION_KEY` when authenticator-app 2FA is in use.
- No manual database migration is required. Migration from the published 2.4.0 container is covered by the automated release gate; supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Stable images are available from both `ghcr.io/mikaelkw/nodecast-tv-plus` and `mikaelkw/nodecast-tv-plus`; GHCR remains the canonical registry.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.4.0` and the existing deployment secrets.
- Far seeking in iPhone Safari's native fullscreen player remains limited by WebKit's view of the generated HLS window and is tracked separately in [#235](https://github.com/MikaelKW/nodecast-tv-plus/issues/235).

## [2.4.0] - 2026-07-18

This feature release adds deployment-level sign-in controls, guided first-run account protection, configurable content and navigation visibility, and browser theme selection.

### Added

- Added optional SSO-only authentication and automatic identity-provider redirection, with deliberate logout and failed-callback safeguards that prevent redirect loops ([#193]).
- Added a first-run MFA recommendation after initial administrator setup, including guided enrollment and a clear path for postponing setup until later ([#195]).
- Added per-source controls for showing Xtream content in Live TV, Movies, and Series, plus the applicable Live TV and TV Guide control for M3U sources ([#197]).
- Added a configurable starting page and independent visibility controls for Home, Live TV, TV Guide, Movies, and Series, while ensuring at least one primary page remains available ([#199]).
- Added browser-scoped Dark, Light, and System theme preferences, with System mode following operating-system changes without a page refresh ([#201]).

### Changed

- Source visibility now controls presentation without deleting or stopping synchronization of provider data ([#197]).
- The sign-in page reports the available authentication methods without exposing provider credentials or internal OIDC configuration ([#193]).

### Fixed

- Improved the contrast of pale and transparent provider artwork across Live TV, Home, and TV Guide in Light mode without changing Dark mode rendering ([#203]).
- Kept successful migration gates successful when optional image cleanup encounters a retained local container that still references a prepared baseline image ([#206]).

### Security

- SSO-only mode hides the local sign-in form and rejects direct local password-login requests while preserving the initial administrator bootstrap safeguard and a documented recovery path ([#193]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.4.0`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values. Preserve `TOTP_ENCRYPTION_KEY` when authenticator-app 2FA is in use.
- `DISABLE_LOCAL_AUTH` and `OIDC_AUTO_REDIRECT` remain optional and default to `false`. Verify SSO administrator access before disabling local sign-in.
- No manual database migration is required. Migration from the published 2.3.1 container is covered by the automated release gate; supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.3.1` and the existing deployment secrets.

## [2.3.1] - 2026-07-16

This patch release improves media-proxy efficiency, deployment health visibility, account-creation safeguards, and Live TV channel browsing.

### Added

- Added a lightweight application readiness endpoint and Docker health checks that verify the local data stores without contacting IPTV providers or exposing configuration details ([#176]).
- Added accessible show/hide controls for password fields during sign-in, initial setup, and local-user creation, with passwords concealed again after form reset ([#186]).
- Added matching password confirmation when creating the initial administrator and when administrators create additional local users, enforced in both the browser and server APIs ([#175], [#186]).

### Changed

- Streamed non-HLS media through the authenticated proxy as bytes arrive, preserving range responses and backpressure while cancelling upstream work after client disconnects; HLS manifest rewriting now uses a bounded buffer ([#174]).

### Fixed

- Kept the setup-only confirmation field hidden during ordinary sign-in after an initial account has already been created ([#178]).
- Preserved expanded channel groups and the Live TV sidebar position when selecting channels already visible in the list ([#181]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.3.1`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values and preserve `TOTP_ENCRYPTION_KEY` when authenticator-app 2FA is in use.
- No manual database migration is required. Migration from the published 2.3.0 container is covered by the automated release gate; supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.3.0` and the existing deployment secrets.

## [2.3.0] - 2026-07-16

This feature release adds secure optional authenticator-app protection for local accounts and makes newly added sources usable without a separate manual refresh.

### Added

- Added automatic initial synchronization for M3U, standalone EPG, and Xtream sources, with visible progress, recoverable failures, and duplicate-submission prevention ([#158]).
- Added optional per-account authenticator-app two-factor authentication for local accounts, with guided QR enrollment, single-use recovery codes, replay protection, attempt limits, and administrator reset controls ([#165]).

### Changed

- Replaced the separate Account and Logout navigation destinations with a username-initial menu containing Account security and Logout ([#165]).

### Fixed

- Kept Account Security, enrollment controls, and the account menu reachable at constrained desktop and mobile viewport sizes ([#165]).
- Restored enrollment and protected-action controls after rejected authentication input instead of leaving the action indefinitely busy ([#165]).

### Security

- TOTP secrets are encrypted at rest with a dedicated deployment key, recovery codes are stored only as keyed hashes, and the password step uses a short-lived server-side challenge instead of exposing temporary authentication tokens to browser storage or URLs ([#165]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.3.0`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values.
- `TOTP_ENCRYPTION_KEY` is optional. Configure a third independent strong value to allow local accounts to enable authenticator-app 2FA, then preserve it across upgrades and include it in secure deployment backups.
- No manual database migration is required. Migration from the published 2.2.2 container is covered by the automated release gate; supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.2.2` and the existing deployment secrets.

## [2.2.2] - 2026-07-15

This patch release improves XMLTV compatibility, iPhone and mobile-browser usability, and deployments served beneath a reverse-proxy subpath.

### Changed

- Added `NODECAST_BASE_PATH` for optional deployments beneath a path such as `/nodecast/`, while preserving existing root-path behavior ([#139], [#142]).
- Extended the migration release gate to verify upgrades from the published NodeCast TV Plus 2.2.1 image in addition to the supported upstream baselines.

### Fixed

- Accepted standards-valid reduced-precision XMLTV timestamps, validated calendar and timezone fields, and skipped malformed programme entries without failing the complete EPG synchronization ([#128]).
- Made Series details render reliably in Safari and other WebKit browsers instead of opening a blank page on iPhone ([#132]).
- Restored access to content below the mobile viewport across Home, Series, Settings, and Login, and kept every navigation destination reachable in landscape orientation ([#136]).
- Kept pages, assets, authentication, APIs, media requests, OIDC callbacks, and server-rewritten HLS manifest URLs within the configured reverse-proxy subpath ([#139], [#142]).
- Restored Live TV fullscreen on iPhone Safari through the native video-player fallback without changing Movies or Series fullscreen behavior ([#146]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.2.2`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values. Changing them signs existing browser sessions out but does not remove accounts or application data.
- No manual database migration is required.
- Root-path deployments require no configuration change. Set `NODECAST_BASE_PATH=/nodecast` only when the reverse proxy publishes the application at that path, and configure the proxy to remove the prefix before forwarding requests.
- Migration from the published 2.2.1 container is covered by the automated release gate. Supported upstream v2.1.1 and 2.1.4 baselines remain covered.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.2.1` and the existing deployment secrets.

## [2.2.1] - 2026-07-14

This patch release improves provider-data integrity, login usability, transcode startup flexibility, and movie/series playback recovery. It also formalizes verified migration guidance for supported upstream installations.

### Changed

- Added `TRANSCODE_START_TIMEOUT_SECONDS` as an optional 1–300 second per-attempt limit for providers that need longer than the unchanged 15-second default to begin transcoding ([#114]).
- Documented the supported upstream migration paths and added a deterministic release gate that validates preservation of accounts, provider configuration, settings, categories, content, favorites, history, hidden items, and authentication state ([#106]).
- Corrected release-note traceability, version-lineage references, and section layout for the first formal Plus release ([#103]).

### Fixed

- Prevented overlapping XMLTV/EPG identifiers from replacing Xtream channel names and logos, including automatic repair during the next source synchronization ([#111]).
- Made local usernames case-insensitive for login and duplicate detection while preserving their stored display spelling and exact-case access for legacy conflicts ([#117]).
- Added bounded network reconnection and media recovery for interrupted movie and series HLS playback, with stream-proxy fallback and an actionable message when recovery is exhausted ([#120]).

### Upgrade notes

- Preserve and back up the existing `/app/data` volume before recreating the container with `2.2.1`.
- Keep the existing strong, distinct `JWT_SECRET` and `SESSION_SECRET` values. Changing them signs existing browser sessions out but does not remove accounts or application data.
- No manual database migration is required.
- `TRANSCODE_START_TIMEOUT_SECONDS` is optional; installations that omit it retain the existing 15-second behavior.
- Migration from the published `2.2.0` container was validated with a persistent data volume. Automated migration gates also continue to cover supported upstream v2.1.1 and 2.1.4 baselines.
- Roll back by restoring the pre-upgrade data backup and recreating the container with `2.2.0` and the existing deployment secrets.

## [2.2.0] - 2026-07-13

This is the first formal NodeCast TV Plus release. It includes the relevant work completed since the repository was forked from NodeCast TV.

### Added

- In-player quality controls for Live TV, movies, and series, with session-only Auto, 4K, 1080p, 720p, and 480p limits ([#88]).
- Actual playback-resolution indicators and best-effort resolution-limit explanations ([#88], [#96]).
- Standards-based OIDC discovery for Authentik, Keycloak, and other compliant providers, with optional endpoint overrides ([#74]).
- Controlled browser, media, hardware-detection, OIDC, transcoding, security, smoke, and real-world playlist tests ([#54], [#64], [#67]).
- Stable multi-architecture container release publishing for `linux/amd64` and `linux/arm64` ([#100]).

### Changed

- Established the NodeCast TV Plus identity while preserving upstream attribution and compatibility-sensitive storage keys ([#1], [#53]).
- Maximum resolution now acts as a ceiling and does not upscale lower-resolution sources ([#78]).
- The SSO option appears only when single sign-on is configured and available ([#81]).
- Container publishing now separates moving development images from immutable release versions ([#100]).
- Refreshed installation, security, testing, legal-use, support, and contribution documentation ([#84]).

### Fixed

- Restored active playback and the previous quality selection when a provider rejects a quality change ([#92]).
- Added non-fatal fallback messaging when provider restrictions prevent a requested or global resolution limit ([#92], [#96]).
- Reduced stale probes, overlapping provider connections, transcode-session races, and cleanup failures during rapid channel changes ([#78]).
- Added retry and reconnection handling for selected transient provider failures ([#78]).
- Corrected Intel Quick Sync Video detection in containers without requiring `lspci` ([#70]).
- Fixed OIDC login failures caused by assuming Keycloak-specific endpoint paths ([#74]).
- Fixed browser-test timing and isolated disposable test state ([#67]).
- Fixed empty EPG startup errors, empty-source VOD errors, and incorrect native-HLS handling for MP4 streams ([#64]).
- Kept large Live TV channel lists within the visible player layout ([#78]).

### Security

- Moved browser authentication to HttpOnly cookies and removed credentials from URLs and browser storage ([#60]).
- Added authorization checks to playback and management APIs, plus cross-site request protections ([#60]).
- Required separate strong JWT and session secrets for production deployments ([#60]).
- Restricted media input protocols and sensitive network targets, constrained FFmpeg protocols, and redacted provider URLs from logs ([#60]).
- Resolved inherited dependency advisories and added a CI gate for high and critical production advisories ([#57]).

### Upgrade notes

- Production deployments must set different strong values for `JWT_SECRET` and `SESSION_SECRET`; see [`.env.example`](.env.example) and [#60].
- Preserve the existing `/app/data` volume when replacing a container. A data backup is recommended before every upgrade.
- No manual database migration is expected for this release.
- Existing compatibility-sensitive browser storage keys remain unchanged.

## Historical lineage (not NodeCast TV Plus releases)

The fork inherited an upstream codebase whose package metadata had advanced beyond the last published upstream tag, `v2.1.1`. Versions [`2.1.2`](https://github.com/technomancer702/nodecast-tv/commit/13badd249ea5af75993d3b3e4fbe2c9abdfd0679), [`2.1.3`](https://github.com/technomancer702/nodecast-tv/commit/ea4a0a4577e635f3bfe19e3c8f0355eb6d04ac0f), and [`2.1.4`](https://github.com/technomancer702/nodecast-tv/commit/4e116d864b497d778db21af9f44be7e8320590d0) were internal upstream development versions; they were never tagged or published as GitHub Releases in either repository. They are recorded here only to explain the version sequence.

Inherited work after upstream `v2.1.1` included:

- Safari/WebKit fullscreen and picture-in-picture support, mobile safe-area handling, and dynamic viewport sizing.
- Movie and series resume, next-episode, and up-next timing corrections.
- Channel-list completeness fixes.

For older published history, see the [upstream NodeCast TV releases](https://github.com/technomancer702/nodecast-tv/releases).

[2.5.1]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.1.1...v2.2.0
[#1]: https://github.com/MikaelKW/nodecast-tv-plus/pull/1
[#53]: https://github.com/MikaelKW/nodecast-tv-plus/pull/53
[#54]: https://github.com/MikaelKW/nodecast-tv-plus/pull/54
[#57]: https://github.com/MikaelKW/nodecast-tv-plus/pull/57
[#60]: https://github.com/MikaelKW/nodecast-tv-plus/pull/60
[#64]: https://github.com/MikaelKW/nodecast-tv-plus/pull/64
[#67]: https://github.com/MikaelKW/nodecast-tv-plus/pull/67
[#70]: https://github.com/MikaelKW/nodecast-tv-plus/pull/70
[#74]: https://github.com/MikaelKW/nodecast-tv-plus/pull/74
[#78]: https://github.com/MikaelKW/nodecast-tv-plus/pull/78
[#81]: https://github.com/MikaelKW/nodecast-tv-plus/pull/81
[#84]: https://github.com/MikaelKW/nodecast-tv-plus/pull/84
[#88]: https://github.com/MikaelKW/nodecast-tv-plus/pull/88
[#92]: https://github.com/MikaelKW/nodecast-tv-plus/pull/92
[#96]: https://github.com/MikaelKW/nodecast-tv-plus/pull/96
[#100]: https://github.com/MikaelKW/nodecast-tv-plus/pull/100
[#103]: https://github.com/MikaelKW/nodecast-tv-plus/pull/103
[#106]: https://github.com/MikaelKW/nodecast-tv-plus/pull/106
[#111]: https://github.com/MikaelKW/nodecast-tv-plus/pull/111
[#114]: https://github.com/MikaelKW/nodecast-tv-plus/pull/114
[#117]: https://github.com/MikaelKW/nodecast-tv-plus/pull/117
[#120]: https://github.com/MikaelKW/nodecast-tv-plus/pull/120
[#128]: https://github.com/MikaelKW/nodecast-tv-plus/pull/128
[#132]: https://github.com/MikaelKW/nodecast-tv-plus/pull/132
[#136]: https://github.com/MikaelKW/nodecast-tv-plus/pull/136
[#139]: https://github.com/MikaelKW/nodecast-tv-plus/pull/139
[#142]: https://github.com/MikaelKW/nodecast-tv-plus/pull/142
[#146]: https://github.com/MikaelKW/nodecast-tv-plus/pull/146
[#158]: https://github.com/MikaelKW/nodecast-tv-plus/pull/158
[#165]: https://github.com/MikaelKW/nodecast-tv-plus/pull/165
[#174]: https://github.com/MikaelKW/nodecast-tv-plus/pull/174
[#175]: https://github.com/MikaelKW/nodecast-tv-plus/pull/175
[#176]: https://github.com/MikaelKW/nodecast-tv-plus/pull/176
[#178]: https://github.com/MikaelKW/nodecast-tv-plus/pull/178
[#181]: https://github.com/MikaelKW/nodecast-tv-plus/pull/181
[#186]: https://github.com/MikaelKW/nodecast-tv-plus/pull/186
[#193]: https://github.com/MikaelKW/nodecast-tv-plus/pull/193
[#195]: https://github.com/MikaelKW/nodecast-tv-plus/pull/195
[#197]: https://github.com/MikaelKW/nodecast-tv-plus/pull/197
[#199]: https://github.com/MikaelKW/nodecast-tv-plus/pull/199
[#201]: https://github.com/MikaelKW/nodecast-tv-plus/pull/201
[#203]: https://github.com/MikaelKW/nodecast-tv-plus/pull/203
[#206]: https://github.com/MikaelKW/nodecast-tv-plus/pull/206
[#213]: https://github.com/MikaelKW/nodecast-tv-plus/pull/213
[#216]: https://github.com/MikaelKW/nodecast-tv-plus/pull/216
[#219]: https://github.com/MikaelKW/nodecast-tv-plus/pull/219
[#221]: https://github.com/MikaelKW/nodecast-tv-plus/pull/221
[#224]: https://github.com/MikaelKW/nodecast-tv-plus/pull/224
[#226]: https://github.com/MikaelKW/nodecast-tv-plus/pull/226
[#228]: https://github.com/MikaelKW/nodecast-tv-plus/pull/228
[#230]: https://github.com/MikaelKW/nodecast-tv-plus/pull/230
[#233]: https://github.com/MikaelKW/nodecast-tv-plus/pull/233
[#242]: https://github.com/MikaelKW/nodecast-tv-plus/pull/242
[#244]: https://github.com/MikaelKW/nodecast-tv-plus/pull/244
[#246]: https://github.com/MikaelKW/nodecast-tv-plus/pull/246
[#248]: https://github.com/MikaelKW/nodecast-tv-plus/pull/248
[#258]: https://github.com/MikaelKW/nodecast-tv-plus/issues/258
[#261]: https://github.com/MikaelKW/nodecast-tv-plus/pull/261
