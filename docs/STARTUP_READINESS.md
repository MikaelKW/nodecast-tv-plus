# Application startup readiness

The sign-in page shows “Server is starting. Please wait.” while required local preparation and initial catalogue imports are incomplete. Sign-in becomes available automatically. Existing authenticated sessions wait without being signed out.

Saved usable catalogues are available after local preparation, even if a later refresh failed or was interrupted. Ordinary background refreshes do not block sign-in. Guide-only sources and the optional Xtream programme-guide download are not conditions for sign-in readiness.

## Waiting and background imports

The initial waiting period is limited to five minutes. When that limit expires, sign-in becomes available and a healthy import continues under its existing synchronization lock. A first import that stops making progress for 30 seconds is stopped. Network reads and database batches count as progress. These limits do not impose a minimum startup delay.

Existing source synchronization status remains available to administrators in Settings. Public startup information contains only the coarse application state, without provider information. Container health is separate from catalogue readiness.

## Existing installations

An automatic, one-time compatibility step handles catalogues created before import completion was tracked separately:

- A saved successful synchronization establishes a completed import, including a successful empty import.
- Existing catalogue rows without a successful latest status are assumed usable. This preserves access after an interrupted legacy refresh without claiming that the earlier import was verified complete.
- A source without either condition requires an initial import, subject to the bounded waiting period.

This compatibility step is not repeated for sources added after upgrading. Failed new imports cannot become completed imports merely because some rows were saved.

Changing a source's connection address or credentials increments a non-sensitive change counter and invalidates its completion record. Renaming a source or saving unchanged connection settings does not. An import started before a connection change cannot mark the replacement connection complete. No credential fingerprints are stored.

## Limits

Catalogue imports retain the existing batch-based storage behavior. Completed batches are not rolled back after an interrupted import. An incomplete M3U download does not trigger its final stale-item purge, and an incomplete guide is not activated.

Readiness does not eliminate every pause caused by synchronous database work or custom add-ons. General synchronization starvation and broader provider timeout behavior are separate from this startup feature.
