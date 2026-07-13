# Changelog

All notable changes to NodeCast TV Plus are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Historical notes below distinguish upstream development from formal NodeCast TV Plus releases.

## [2.2.0] - 2026-07-13

This is the first formal NodeCast TV Plus release. It includes the relevant work completed since the repository was forked from NodeCast TV.

### Added

- In-player quality controls for Live TV, movies, and series, with session-only Auto, 4K, 1080p, 720p, and 480p limits.
- Actual playback-resolution indicators and best-effort resolution-limit explanations.
- Standards-based OIDC discovery for Authentik, Keycloak, and other compliant providers, with optional endpoint overrides.
- Controlled browser, media, hardware-detection, OIDC, transcoding, security, smoke, and real-world playlist tests.
- Multi-architecture container publishing for `linux/amd64` and `linux/arm64`.

### Changed

- Established the NodeCast TV Plus identity while preserving upstream attribution and compatibility-sensitive storage keys.
- Maximum resolution now acts as a ceiling and does not upscale lower-resolution sources.
- The SSO option appears only when single sign-on is configured and available.
- Container publishing now separates moving development images from immutable release versions.
- Refreshed installation, security, testing, legal-use, support, and contribution documentation.

### Fixed

- Restored active playback and the previous quality selection when a provider rejects a quality change.
- Added non-fatal fallback messaging when provider restrictions prevent a requested or global resolution limit.
- Reduced stale probes, overlapping provider connections, transcode-session races, and cleanup failures during rapid channel changes.
- Added retry and reconnection handling for selected transient provider failures.
- Corrected Intel Quick Sync Video detection in containers without requiring `lspci`.
- Fixed OIDC login failures caused by assuming Keycloak-specific endpoint paths.
- Fixed browser-test timing and isolated disposable test state.
- Fixed empty EPG startup errors, empty-source VOD errors, and incorrect native-HLS handling for MP4 streams.
- Kept large Live TV channel lists within the visible player layout.

### Security

- Moved browser authentication to HttpOnly cookies and removed credentials from URLs and browser storage.
- Added authorization checks to playback and management APIs, plus cross-site request protections.
- Required separate strong JWT and session secrets for production deployments.
- Restricted media input protocols and sensitive network targets, constrained FFmpeg protocols, and redacted provider URLs from logs.
- Resolved inherited dependency advisories and added a CI gate for high and critical production advisories.

### Upgrade notes

- Production deployments must set different strong values for `JWT_SECRET` and `SESSION_SECRET`; see [`.env.example`](.env.example).
- Preserve the existing `/app/data` volume when replacing a container. A data backup is recommended before every upgrade.
- No manual database migration is expected for this release.
- Existing compatibility-sensitive browser storage keys remain unchanged.

## Historical lineage (not NodeCast TV Plus releases)

The fork inherited an upstream codebase whose package metadata had advanced beyond the last published upstream tag, `v2.1.1`. Versions `2.1.2`, `2.1.3`, and `2.1.4` were internal upstream development versions; they were never tagged or published as GitHub Releases in either repository. They are recorded here only to explain the version sequence.

Inherited work after upstream `v2.1.1` included:

- Safari/WebKit fullscreen and picture-in-picture support, mobile safe-area handling, and dynamic viewport sizing.
- Movie and series resume, next-episode, and up-next timing corrections.
- Channel-list completeness fixes.

For older published history, see the [upstream NodeCast TV releases](https://github.com/technomancer702/nodecast-tv/releases).

[2.2.0]: https://github.com/MikaelKW/nodecast-tv-plus/compare/v2.1.1...v2.2.0
