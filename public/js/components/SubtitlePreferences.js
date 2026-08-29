(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SubtitlePreferences = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MODES = Object.freeze({
        OFF: 'off',
        DEFAULT: 'default',
        FORCED: 'forced',
        PREFERRED: 'preferred'
    });

    const DEFAULT_PREFERENCES = Object.freeze({ language: '', mode: MODES.OFF });
    const VALID_MODES = new Set(Object.values(MODES));
    const LANGUAGE_ALIASES = Object.freeze({
        eng: 'en',
        nor: 'no',
        nob: 'nb',
        nno: 'nn',
        dan: 'da',
        swe: 'sv',
        fin: 'fi',
        isl: 'is',
        ice: 'is',
        deu: 'de',
        ger: 'de',
        fra: 'fr',
        fre: 'fr',
        spa: 'es',
        ita: 'it',
        por: 'pt',
        nld: 'nl',
        dut: 'nl',
        pol: 'pl',
        ces: 'cs',
        cze: 'cs',
        slk: 'sk',
        slo: 'sk',
        hun: 'hu',
        ron: 'ro',
        rum: 'ro',
        bul: 'bg',
        hrv: 'hr',
        srp: 'sr',
        slv: 'sl',
        est: 'et',
        lav: 'lv',
        lit: 'lt',
        ukr: 'uk',
        rus: 'ru',
        tur: 'tr',
        ell: 'el',
        gre: 'el',
        ara: 'ar',
        heb: 'he',
        hin: 'hi',
        zho: 'zh',
        chi: 'zh',
        jpn: 'ja',
        kor: 'ko'
    });

    function normalizeLanguage(value) {
        const language = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '-');
        if (!language || language === 'und' || language === 'unknown') return '';
        const primary = language.split('-')[0];
        return LANGUAGE_ALIASES[primary] || primary;
    }

    function normalizePreferences(value) {
        const candidate = value && typeof value === 'object' ? value : {};
        const language = normalizeLanguage(candidate.language);
        let mode = VALID_MODES.has(candidate.mode) ? candidate.mode : DEFAULT_PREFERENCES.mode;
        if (mode === MODES.PREFERRED && !language) mode = MODES.OFF;
        return {
            language,
            mode
        };
    }

    function languageMatches(trackLanguage, preferredLanguage) {
        const preferred = normalizeLanguage(preferredLanguage);
        const track = normalizeLanguage(trackLanguage);
        if (!preferred || !track) return false;
        if (preferred === 'no') return track === 'no' || track === 'nb' || track === 'nn';
        return track === preferred;
    }

    function selectPreferredSubtitleTrack(tracks, value) {
        const preferences = normalizePreferences(value);
        const candidates = (Array.isArray(tracks) ? tracks : [])
            .map((track, position) => ({
                ...track,
                position: Number.isInteger(track?.position) ? track.position : position
            }))
            .filter(track => track.kind !== 'metadata');
        if (preferences.mode === MODES.OFF || candidates.length === 0) return null;

        const matching = candidates.filter(track => languageMatches(track.language || track.lang, preferences.language));
        const first = list => list.length > 0 ? list[0] : null;

        if (preferences.mode === MODES.PREFERRED) {
            return first(matching.filter(track => track.default))
                || first(matching.filter(track => track.forced))
                || first(matching);
        }

        if (preferences.mode === MODES.FORCED) {
            return first(matching.filter(track => track.forced))
                || (!preferences.language ? first(candidates.filter(track => track.forced)) : null);
        }

        if (preferences.mode === MODES.DEFAULT) {
            return first(matching.filter(track => track.default))
                || first(matching.filter(track => track.forced))
                || first(candidates.filter(track => track.default))
                || first(candidates.filter(track => track.forced));
        }

        return null;
    }

    return {
        MODES,
        DEFAULT_PREFERENCES,
        normalizeLanguage,
        normalizePreferences,
        languageMatches,
        selectPreferredSubtitleTrack
    };
}));
