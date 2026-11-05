# Enigma2 / OpenWebif sources

Add a receiver's bouquet export URL as an M3U source, for example `http://receiver.example/web/services.m3u?bRef=...`.

M3U entries with `#EXTVLCOPT:program=202` preserve that MPEG-TS program through synchronization, channel lists, favourites, probing, remux and managed playback. Valid program numbers are 1–65535. Entries without a program tag retain their existing playback behavior. The current structured catalogue stores this metadata without adding a separate database column.

## Optional receiver tuning

For a receiver that needs tuning before opening a stream, enable **Zap before streaming (Enigma2/OpenWebif)** in its M3U source settings. Set a delay from 0 to 10000 milliseconds; the default is 1500.

Playback releases the previous stream, requests tuning from the configured receiver, waits for the delay, then opens the selected stream. Changing channels or pressing Stop cancels pending startup. Leaving Live TV also cancels pending tuning, but established background playback keeps the normal Plus behavior.

The receiver must expose OpenWebif at the origin of its configured M3U URL. Tuning is restricted to visible imported live channels with an Enigma2 service reference in the stream URL or item identifier. A receiver rejection or failed tuning request is reported as a playback failure rather than silently opening a different channel. Cancellation cannot undo a tuning command the receiver has already executed.

Program selection is supported in direct-remux and managed conversion paths. Raw program-tagged streams use remux even when automatic conversion is disabled, so the browser does not select an arbitrary program itself. Ordinary M3U and Xtream sources do not enable tuning by default.
