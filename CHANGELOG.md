# Changelog

All notable changes to NodeCast TV Plus are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Historical notes below distinguish upstream development from formal NodeCast TV Plus releases.

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
