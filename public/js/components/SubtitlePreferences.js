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

    const EDGE_STYLES = Object.freeze({
        NONE: 'none',
        SHADOW: 'shadow',
        OUTLINE: 'outline'
    });

    const DEFAULT_APPEARANCE = Object.freeze({
        textScale: 100,
        textColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0,
        edgeStyle: EDGE_STYLES.OUTLINE,
        verticalPosition: 7
    });

    const DEFAULT_PREFERENCES = Object.freeze({
        language: '',
        mode: MODES.OFF,
        appearance: DEFAULT_APPEARANCE
    });
    const VALID_MODES = new Set(Object.values(MODES));
    const VALID_EDGE_STYLES = new Set(Object.values(EDGE_STYLES));
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

    function clampInteger(value, fallback, minimum, maximum, step = 1) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        const bounded = Math.max(minimum, Math.min(maximum, number));
        return Math.round(bounded / step) * step;
    }

    function normalizeColor(value, fallback) {
        const color = String(value || '').trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
    }

    function normalizeAppearance(value) {
        const candidate = value && typeof value === 'object' ? value : {};
        const edgeStyle = VALID_EDGE_STYLES.has(candidate.edgeStyle)
            ? candidate.edgeStyle
            : DEFAULT_APPEARANCE.edgeStyle;
        return {
            textScale: clampInteger(candidate.textScale, DEFAULT_APPEARANCE.textScale, 75, 175, 5),
            textColor: normalizeColor(candidate.textColor, DEFAULT_APPEARANCE.textColor),
            backgroundColor: normalizeColor(candidate.backgroundColor, DEFAULT_APPEARANCE.backgroundColor),
            backgroundOpacity: clampInteger(
                candidate.backgroundOpacity,
                DEFAULT_APPEARANCE.backgroundOpacity,
                0,
                100,
                5
            ),
            edgeStyle,
            verticalPosition: clampInteger(
                candidate.verticalPosition,
                DEFAULT_APPEARANCE.verticalPosition,
                4,
                30
            )
        };
    }

    function normalizePreferences(value) {
        const candidate = value && typeof value === 'object' ? value : {};
        const language = normalizeLanguage(candidate.language);
        let mode = VALID_MODES.has(candidate.mode) ? candidate.mode : DEFAULT_PREFERENCES.mode;
        if (mode === MODES.PREFERRED && !language) mode = MODES.OFF;
        return {
            language,
            mode,
            appearance: normalizeAppearance(candidate.appearance)
        };
    }

    function hexToRgb(value) {
        const color = normalizeColor(value, '#000000').slice(1);
        return {
            red: parseInt(color.slice(0, 2), 16),
            green: parseInt(color.slice(2, 4), 16),
            blue: parseInt(color.slice(4, 6), 16)
        };
    }

    function formatDecimal(value) {
        return String(Number(Number(value).toFixed(3)));
    }

    function getAppearanceCssVariables(value) {
        const appearance = normalizeAppearance(value);
        const scale = appearance.textScale / 100;
        const text = hexToRgb(appearance.textColor);
        const background = hexToRgb(appearance.backgroundColor);
        const luminance = (0.2126 * text.red + 0.7152 * text.green + 0.0722 * text.blue) / 255;
        const edgeColor = luminance < 0.45 ? '255, 255, 255' : '0, 0, 0';
        const outline = [
            `-2px -2px 2px rgba(${edgeColor}, 0.95)`,
            `2px -2px 2px rgba(${edgeColor}, 0.95)`,
            `-2px 2px 2px rgba(${edgeColor}, 0.95)`,
            `2px 2px 2px rgba(${edgeColor}, 0.95)`,
            `0 0 4px rgb(${edgeColor})`
        ].join(', ');
        const shadow = `0 2px 4px rgba(${edgeColor}, 0.95), 0 0 2px rgba(${edgeColor}, 0.9)`;
        const textShadow = appearance.edgeStyle === EDGE_STYLES.NONE
            ? 'none'
            : appearance.edgeStyle === EDGE_STYLES.SHADOW ? shadow : outline;
        return {
            '--subtitle-text-color': appearance.textColor,
            '--subtitle-background-color': `rgba(${background.red}, ${background.green}, ${background.blue}, ${formatDecimal(appearance.backgroundOpacity / 100)})`,
            '--subtitle-text-shadow': textShadow,
            '--subtitle-font-min-size': `${formatDecimal(20 * scale)}px`,
            '--subtitle-font-fluid-size': `${formatDecimal(2.1 * scale)}vw`,
            '--subtitle-font-max-size': `${formatDecimal(42 * scale)}px`,
            '--subtitle-cue-padding': appearance.backgroundOpacity > 0 ? '0.06em 0.24em' : '0',
            '--subtitle-cue-radius': appearance.backgroundOpacity > 0 ? '0.12em' : '0',
            '--subtitle-position-percent': `${appearance.verticalPosition}%`
        };
    }

    function applyAppearanceStyles(element, value) {
        if (!element?.style?.setProperty) return normalizeAppearance(value);
        const appearance = normalizeAppearance(value);
        for (const [property, propertyValue] of Object.entries(getAppearanceCssVariables(appearance))) {
            element.style.setProperty(property, propertyValue);
        }
        return appearance;
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
            // A forced track normally contains only dialogue that differs from
            // the main audio language. "Always preferred" should choose the
            // complete matching subtitle track when one exists, even if an
            // earlier matching forced track is marked as default.
            const complete = matching.filter(track => !track.forced);
            return first(complete.filter(track => track.default))
                || first(complete)
                || first(matching.filter(track => track.default))
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
        EDGE_STYLES,
        DEFAULT_PREFERENCES,
        DEFAULT_APPEARANCE,
        normalizeLanguage,
        normalizeAppearance,
        normalizePreferences,
        getAppearanceCssVariables,
        applyAppearanceStyles,
        languageMatches,
        selectPreferredSubtitleTrack
    };
}));
