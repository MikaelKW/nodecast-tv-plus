# Diagnostics and support snapshots

The **Settings > Diagnostics** page gives administrators a recent, privacy-conscious view of playback and source synchronization. It can help distinguish a provider problem, browser playback problem, conversion failure, or synchronization failure without exposing provider details or raw application logs.

The page is available only to administrator accounts. Authorization is also enforced by the server, so a viewer cannot access the diagnostics data by calling the API directly.

## What the page shows

### Application and resources

- Installed application version and exact source revision, when the image provides one.
- Process uptime.
- Current process memory and JavaScript heap use.

These values identify the running build and provide a small resource snapshot. They are not a historical performance graph.

### Managed playback sessions

Active server-managed playback sessions appear with a generated trace ID, current state, and age. These are normally sessions that NodeCast TV Plus is remuxing or transcoding.

Direct and browser-remuxed playback paths do not remain in this card. Their lifecycle is recorded under **Recent events** instead.

### Source synchronization

The latest known synchronization state is shown for up to 20 sources. Only the internal numeric source ID, status, and timestamp are displayed. Source names, provider addresses, credentials, and raw error messages are excluded.

Common states are:

| State | Meaning |
| --- | --- |
| `syncing` | Synchronization is currently running. |
| `success` | The last synchronization completed. |
| `error` | The last synchronization failed. The provider connection and source configuration may need checking. |
| `unavailable` | A usable status is not available. |

### Recent events and trace IDs

Recent events explain the selected playback path and important lifecycle changes in plain language. Events belonging to the same playback attempt or synchronization run share a generated trace ID. Follow that ID from the first event to the last to understand one attempt without mixing it with another channel change or refresh.

Examples include:

| Event text | Meaning |
| --- | --- |
| Playback was requested. | A server-managed playback attempt began. |
| HLS playback without conversion was selected. | The browser was directed to play an HLS stream without server-side conversion. |
| Automatic stream repackaging was selected. | The stream was remuxed into a browser-compatible container without intentionally converting its media tracks. |
| Video is copied and audio is converted for compatibility. | The video is preserved while the audio is converted. |
| A playable playlist is ready. | A server-managed HLS playlist became available to the browser. |
| The browser started playback. | The media element reported that playback began. |
| The live input disconnected; reconnecting. | The input was interrupted and the server is attempting to recover it. |
| The first connection failed; retrying once. | The initial connection failed and the bounded retry is in progress. |
| Playback was replaced by another request. | A channel change or another playback request replaced the earlier attempt. |
| Source synchronization failed. | The synchronization did not complete. Provider details and raw errors remain excluded. |

The event history is held only in application memory. It contains at most 128 entries, events expire after one hour, and restarting the application clears it. The page refreshes while it is open; **Refresh** requests an immediate update.

## Investigate a playback problem

1. Open **Settings > Diagnostics** in another tab or return to it immediately after reproducing the problem.
2. Note the newest trace ID and read its events from the earliest entry to the latest.
3. Confirm which playback path was selected.
4. Look for a ready or started event. If neither appears, the later failure or retry text can help identify which stage did not complete.
5. If the input repeatedly reconnects, test another known-working channel and check provider availability and server network access.
6. If the browser reports that playback failed or was blocked, compare another browser and review browser autoplay, codec, mixed-content, and proxy behavior.

Diagnostics are best-effort observations, not a complete log. The absence of an event does not prove that a step never occurred.

## Investigate a synchronization problem

1. Refresh the affected source under **Settings > Sources**.
2. Open **Settings > Diagnostics** and find the matching numeric source ID.
3. Follow the trace ID shared by its synchronization events.
4. If the result is `error`, verify the source configuration and provider availability without posting credentials or complete provider addresses publicly.

## Prepare a support snapshot

The support snapshot is a small JSON document intended for issue investigation.

1. Open **Settings > Diagnostics** as an administrator.
2. Select **Prepare preview**.
3. Read the complete preview and confirm that it is appropriate to share.
4. Select **Download reviewed snapshot**. The downloaded file contains the exact text shown in the preview.

Preparing or downloading a snapshot does not upload it. Share it only through a destination you choose.

The snapshot is limited to 48 KiB and contains no more than:

- 50 recent events;
- 20 source status entries; and
- 16 active managed playback sessions.

Its fixed allowlist includes the application version and revision, process resource values, generated trace IDs, fixed status and reason codes, event timestamps, and numeric source IDs. It excludes provider URLs, credentials, tokens, cookies, source names, account details, personal information, raw errors, raw logs, media, request headers, and playback command arguments.

Even though the snapshot is intentionally restricted, always review the preview before sharing it. Screenshots and separate logs are not covered by the snapshot's allowlist and must be checked and redacted independently.

## Limits

- Diagnostics reset when the application process restarts.
- Timestamps on the page use the browser's local time. Snapshot timestamps use ISO 8601 UTC.
- Memory figures describe the application process, not total host or container usage.
- Source IDs and trace IDs are correlation aids; they do not identify provider accounts.
- The page does not replace container logs when deeper investigation is necessary. Remove provider addresses, credentials, query tokens, cookies, personal details, and private media information before sharing any separate logs or screenshots.
