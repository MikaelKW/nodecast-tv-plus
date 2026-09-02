(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.VodDuration = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function parse(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) && value > 0 ? value : 0;
        }

        if (typeof value !== 'string') return 0;
        const normalized = value.trim();
        if (!normalized) return 0;

        if (/^\d+(?:\.\d+)?$/.test(normalized)) {
            const seconds = Number(normalized);
            return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        }

        const parts = normalized.split(':');
        if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) {
            return 0;
        }

        const numbers = parts.map(Number);
        if (numbers.slice(-2).some(part => part >= 60)) return 0;

        const seconds = parts.length === 3
            ? (numbers[0] * 3600) + (numbers[1] * 60) + numbers[2]
            : (numbers[0] * 60) + numbers[1];
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    }

    function firstValid(...values) {
        for (const value of values) {
            const duration = parse(value);
            if (duration > 0) return duration;
        }
        return 0;
    }

    function fromContent(content = {}) {
        return firstValid(
            content.durationSeconds,
            content.duration_secs,
            content.duration,
            content.runtime_secs,
            content.info?.duration_secs,
            content.info?.duration,
            content.movie_data?.duration_secs,
            content.movie_data?.duration
        );
    }

    return { parse, firstValid, fromContent };
}));
