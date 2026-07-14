'use strict';

const DEFAULT_TRANSCODE_START_TIMEOUT_SECONDS = 15;
const MIN_TRANSCODE_START_TIMEOUT_SECONDS = 1;
const MAX_TRANSCODE_START_TIMEOUT_SECONDS = 300;

function parseTranscodeStartTimeoutSeconds(value = process.env.TRANSCODE_START_TIMEOUT_SECONDS) {
    if (value === undefined) {
        return DEFAULT_TRANSCODE_START_TIMEOUT_SECONDS;
    }

    const normalized = String(value).trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
        throw new Error(
            `TRANSCODE_START_TIMEOUT_SECONDS must be a whole number between ${MIN_TRANSCODE_START_TIMEOUT_SECONDS} and ${MAX_TRANSCODE_START_TIMEOUT_SECONDS}.`
        );
    }

    const seconds = Number(normalized);
    if (!Number.isSafeInteger(seconds)
        || seconds < MIN_TRANSCODE_START_TIMEOUT_SECONDS
        || seconds > MAX_TRANSCODE_START_TIMEOUT_SECONDS) {
        throw new Error(
            `TRANSCODE_START_TIMEOUT_SECONDS must be a whole number between ${MIN_TRANSCODE_START_TIMEOUT_SECONDS} and ${MAX_TRANSCODE_START_TIMEOUT_SECONDS}.`
        );
    }

    return seconds;
}

const TRANSCODE_START_TIMEOUT_MS = parseTranscodeStartTimeoutSeconds() * 1000;

module.exports = {
    DEFAULT_TRANSCODE_START_TIMEOUT_SECONDS,
    MIN_TRANSCODE_START_TIMEOUT_SECONDS,
    MAX_TRANSCODE_START_TIMEOUT_SECONDS,
    TRANSCODE_START_TIMEOUT_MS,
    parseTranscodeStartTimeoutSeconds
};
