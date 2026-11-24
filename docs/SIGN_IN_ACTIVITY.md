# Sign-in activity and retention

Administrators can browse the sign-in log in **Settings > Logs**. It records successful and failed sign-ins, first-factor handoffs to two-factor verification, authenticated sign-outs and initial setup. A completed sign-in is recorded only after all required factors succeed.

Password, verification-code and recovery-code fields, session cookies and authentication tokens are excluded from recording. Attempted usernames are recorded with character and length limits and can contain sensitive information accidentally entered in that field. Account names, addresses and client details remain personal data. The sign-in log is separate from the sanitized Diagnostics support snapshot.

## Storage allowances

The default policy keeps entries for 90 days with a maximum allowance of 50,000 rows. The maximum is shared between protected activity (70%), challenged two-factor failures (15%) and ordinary failures (15%). Each failure group reserves 10% of its share for summaries. Failure records cannot consume the allowance for protected activity or the other failure group.

Protected activity includes completed sign-ins, genuine first-factor successes that require two-factor verification, authenticated sign-outs and successful initial setup. A failure receives protected two-factor treatment only when associated with a genuine server-issued challenge. The first failure after that challenge expires retains this context. Once the expired challenge is cleared, subsequent requests without a challenge are ordinary failures.

Within protected activity, cleanup removes the oldest entries of the busiest accounts first. An account with spare entries loses those before a quiet account loses its only entry. If the allowance cannot hold even one entry per represented account, the oldest remaining records are replaced. A one-time warning per running process reports when this fallback begins. No fixed-size log can preserve one entry for unlimited distinct accounts, including accounts provisioned through SSO.

Age expiry applies to every group and summary. Cleanup runs at startup, hourly, after 200 newly inserted rows and when the policy changes. Counts can briefly exceed allowances between cleanups. Cleanup is skipped if the saved policy cannot be read.

## Recording and grouping

Within each 60-second recording window:

- Ordinary failures admit up to 60 individual entries overall and five per source.
- Challenged two-factor failures admit up to 30 individual entries overall and five per challenge.
- Protected activity admits up to 120 individual entries overall and 12 per account, shared across its event types.

Excess events are counted in summaries rather than recorded individually. These limits affect logging, not authentication decisions. Source/account tracking is bounded. Up to 128 per-account activity summary keys are pending at once. Additional activity beyond that capacity becomes a neutral mixed-activity summary with counts by event, outcome and method, rather than invented account attribution.

Per-account activity summaries retain the account, event type, outcome and method. Completed sign-ins and incomplete two-factor handoffs are never combined into a claimed completed sign-in. Failure summaries do not identify individual accounts or addresses. No summary carries individual IP addresses or flow IDs.

Counts are normally combined into hourly summary rows, with first and last event times. Pending increments are saved every 30 seconds, on recording-window rollover and during shutdown. Saving again updates the appropriate hourly row rather than adding another row. Storage unavailability can extend an unsaved summary's time range across an hour boundary.

## Filters and summary counts

Date filters match a summary when any part of its first-to-last time range overlaps the selected dates. The displayed count always covers the **whole summary**, not just the overlapping part. Individual entries continue to match their event time.

Account filters can match per-account activity summaries. IP filters do not match summaries. Failure summaries and mixed-activity overflow summaries have no individual account attribution and therefore do not match account filters. The **Grouped activity**, **Grouped failures** and **Mixed activity** filters make these rows discoverable. Event filters such as **Sign-out** also include per-account summaries of that event.

## Shutdown and recovery

Pending counts are saved at the start of normal shutdown and again after active requests finish. The internal forced-exit path makes a final best-effort save. Saved rows and counts survive restarts, and subsequent increments can update the same hourly row.

An external force-kill, process/host crash or unavailable storage can still prevent a save. Normally only counts since the most recent successful flush, up to about 30 seconds, are at risk. Continuing storage errors can extend that interval. Per-minute admission counters restart with the process. Recording, summary and cleanup warnings are each rate limited independently.
