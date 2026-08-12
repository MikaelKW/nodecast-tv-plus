'use strict';

const { spawnSync } = require('node:child_process');

function systemCommandAvailable(command, spawn = spawnSync) {
    const result = spawn(command, ['-version'], {
        stdio: 'ignore',
        windowsHide: true
    });
    return result.status === 0;
}

function normalizeBundledPath(binaryPath) {
    if (!binaryPath) return null;
    return binaryPath.includes('app.asar')
        ? binaryPath.replace('app.asar', 'app.asar.unpacked')
        : binaryPath;
}

function resolveFFmpegPath(options = {}) {
    const commandAvailable = options.commandAvailable || systemCommandAvailable;
    const loadBundled = options.loadBundled || (() => require('ffmpeg-static'));

    if (commandAvailable('ffmpeg')) {
        return { path: 'ffmpeg', source: 'system' };
    }

    try {
        const bundledPath = normalizeBundledPath(loadBundled());
        if (bundledPath) return { path: bundledPath, source: 'bundled' };
    } catch (error) {
        // ffmpeg-static is optional; installations with system FFmpeg remain supported.
    }

    return { path: null, source: 'unavailable' };
}

module.exports = {
    normalizeBundledPath,
    resolveFFmpegPath,
    systemCommandAvailable
};
