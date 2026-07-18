/**
 * Browser-scoped appearance preference.
 *
 * This file is loaded before the main stylesheet so the saved theme can be
 * applied before the page is painted. Theme preferences intentionally stay in
 * this browser: different devices can independently use Dark, Light, or System.
 */
(function initializeTheme(global) {
    const STORAGE_KEY = 'nodecast_tv_theme';
    const THEME_VALUES = new Set(['dark', 'light', 'system']);
    const systemPreference = global.matchMedia('(prefers-color-scheme: dark)');

    function normalize(preference) {
        return THEME_VALUES.has(preference) ? preference : 'dark';
    }

    function getPreference() {
        try {
            return normalize(global.localStorage.getItem(STORAGE_KEY));
        } catch (_) {
            return 'dark';
        }
    }

    function resolve(preference) {
        return preference === 'system'
            ? (systemPreference.matches ? 'dark' : 'light')
            : preference;
    }

    function updateThemeColor(resolvedTheme) {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.content = resolvedTheme === 'light' ? '#f7f7fb' : '#0a0a0f';
        }
    }

    function apply(preference, options = {}) {
        const normalized = normalize(preference);
        const resolved = resolve(normalized);

        if (options.persist !== false) {
            try {
                global.localStorage.setItem(STORAGE_KEY, normalized);
            } catch (_) {
                // The visual choice still applies when browser storage is unavailable.
            }
        }

        document.documentElement.dataset.theme = resolved;
        document.documentElement.dataset.themePreference = normalized;
        document.documentElement.style.colorScheme = resolved;
        updateThemeColor(resolved);

        document.dispatchEvent(new CustomEvent('nodecast:themechange', {
            detail: { preference: normalized, resolvedTheme: resolved }
        }));

        return { preference: normalized, resolvedTheme: resolved };
    }

    const handleSystemChange = () => {
        if (getPreference() === 'system') apply('system', { persist: false });
    };
    if (typeof systemPreference.addEventListener === 'function') {
        systemPreference.addEventListener('change', handleSystemChange);
    } else if (typeof systemPreference.addListener === 'function') {
        systemPreference.addListener(handleSystemChange);
    }

    global.NodeCastTheme = {
        apply,
        getPreference,
        getResolvedTheme: () => resolve(getPreference())
    };

    apply(getPreference(), { persist: false });
})(window);
