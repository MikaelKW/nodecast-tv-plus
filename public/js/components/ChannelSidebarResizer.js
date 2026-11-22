(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ChannelSidebarResizer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const STORAGE_KEY = 'nodecast_tv_channel_sidebar_width';
    const WIDTH_PROPERTY = '--channel-sidebar-width';
    const MIN_WIDTH = 220;
    const MAX_WIDTH = 640;
    // Keep at least this share of the viewport for the player.
    const MAX_VIEWPORT_SHARE = 0.6;
    const KEYBOARD_STEP = 16;
    const KEYBOARD_LARGE_STEP = 64;
    const DESKTOP_QUERY = '(min-width: 769px)';

    function maxWidthFor(viewportWidth) {
        const viewport = Number(viewportWidth);
        if (!Number.isFinite(viewport) || viewport <= 0) return MAX_WIDTH;
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(viewport * MAX_VIEWPORT_SHARE)));
    }

    function clampWidth(width, viewportWidth) {
        const value = Number(width);
        if (!Number.isFinite(value)) return null;
        return Math.round(Math.max(MIN_WIDTH, Math.min(maxWidthFor(viewportWidth), value)));
    }

    function readStoredWidth(storage) {
        try {
            const raw = storage?.getItem(STORAGE_KEY);
            if (raw === null || raw === undefined || raw === '') return null;
            const value = Number(raw);
            return Number.isFinite(value) && value > 0 ? value : null;
        } catch {
            return null;
        }
    }

    function writeStoredWidth(storage, width) {
        try {
            if (width === null) storage?.removeItem(STORAGE_KEY);
            else storage?.setItem(STORAGE_KEY, String(width));
        } catch {
            // Storage can be unavailable in private browsing; resizing still works.
        }
    }

    /**
     * Make the Live TV channel sidebar resizable on desktop layouts by dragging
     * its edge or using the keyboard. The chosen width persists per browser.
     */
    function attach({
        sidebar,
        handle,
        storage = globalThis.localStorage,
        view = globalThis.window
    } = {}) {
        if (!sidebar || !handle) return null;

        let customWidth = null;
        let drag = null;

        const viewportWidth = () => view?.innerWidth;
        const isDesktop = () => typeof view?.matchMedia !== 'function'
            || view.matchMedia(DESKTOP_QUERY).matches;

        function currentWidth() {
            return Math.round(sidebar.getBoundingClientRect().width);
        }

        function updateAria(width) {
            handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
            handle.setAttribute('aria-valuemax', String(maxWidthFor(viewportWidth())));
            if (Number.isFinite(width) && width > 0) {
                handle.setAttribute('aria-valuenow', String(width));
            }
        }

        function apply(width) {
            if (width === null) {
                sidebar.style.removeProperty(WIDTH_PROPERTY);
            } else {
                sidebar.style.setProperty(WIDTH_PROPERTY, `${width}px`);
            }
            updateAria(width ?? currentWidth());
        }

        function setWidth(width, { persist = true } = {}) {
            const next = clampWidth(width, viewportWidth());
            if (next === null) return;
            customWidth = next;
            apply(next);
            if (persist) writeStoredWidth(storage, next);
        }

        function reset() {
            customWidth = null;
            apply(null);
            writeStoredWidth(storage, null);
        }

        function finishDrag(event) {
            if (!drag) return;
            if (event && drag.pointerId !== event.pointerId) return;
            handle.releasePointerCapture?.(drag.pointerId);
            drag = null;
            handle.classList.remove('active');
            sidebar.classList.remove('resizing');
            if (customWidth !== null) writeStoredWidth(storage, customWidth);
        }

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !isDesktop() || sidebar.classList.contains('collapsed')) return;
            drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidth() };
            handle.setPointerCapture?.(event.pointerId);
            handle.classList.add('active');
            // Disable the width transition so the edge follows the pointer.
            sidebar.classList.add('resizing');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            setWidth(drag.startWidth + (event.clientX - drag.startX), { persist: false });
        });

        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('lostpointercapture', finishDrag);
        handle.addEventListener('dblclick', reset);

        handle.addEventListener('keydown', event => {
            if (!isDesktop()) return;
            const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
            const width = customWidth ?? currentWidth();
            switch (event.key) {
                case 'ArrowLeft': setWidth(width - step); break;
                case 'ArrowRight': setWidth(width + step); break;
                case 'Home': setWidth(MIN_WIDTH); break;
                case 'End': setWidth(maxWidthFor(viewportWidth())); break;
                case 'Escape': reset(); break;
                default: return;
            }
            event.preventDefault();
            // The player handles arrow keys on the document (volume and
            // channel changes); keep handled resize keys away from it.
            event.stopPropagation();
        });

        // A stored width can exceed a smaller window; clamp it without
        // overwriting the stored preference.
        view?.addEventListener?.('resize', () => {
            if (customWidth === null) return updateAria(currentWidth());
            const stored = readStoredWidth(storage) ?? customWidth;
            customWidth = clampWidth(stored, viewportWidth());
            apply(customWidth);
        });

        // The Live TV page can be hidden when this runs (width 0), so refresh
        // the current value once the sidebar is laid out and on focus.
        const refreshAria = () => updateAria(customWidth ?? currentWidth());
        handle.addEventListener('focus', refreshAria);
        const ResizeObserverClass = view?.ResizeObserver || globalThis.ResizeObserver;
        if (typeof ResizeObserverClass === 'function') {
            try {
                new ResizeObserverClass(refreshAria).observe(sidebar);
            } catch {
                // Focus still refreshes the value.
            }
        }

        const stored = readStoredWidth(storage);
        if (stored !== null) setWidth(stored, { persist: false });
        else updateAria(currentWidth());

        return {
            setWidth,
            reset,
            get width() { return customWidth; }
        };
    }

    return {
        STORAGE_KEY,
        WIDTH_PROPERTY,
        MIN_WIDTH,
        MAX_WIDTH,
        maxWidthFor,
        clampWidth,
        readStoredWidth,
        attach
    };
}));
