'use strict';

const assert = require('node:assert/strict');
const Resizer = require('../public/js/components/ChannelSidebarResizer');

function createElement(initialWidth = 320) {
    let renderedWidth = initialWidth;
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    const properties = new Map();
    const element = {
        captured: null,
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name)
        },
        style: {
            setProperty: (name, value) => properties.set(name, value),
            removeProperty: name => properties.delete(name),
            getPropertyValue: name => properties.get(name) || ''
        },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name) ?? null,
        addEventListener: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatch(type, event = {}) {
            const payload = {
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.propagationStopped = true; },
                ...event
            };
            for (const listener of listeners.get(type) || []) listener(payload);
            return payload;
        },
        setPointerCapture(id) { this.captured = id; },
        releasePointerCapture(id) { if (this.captured === id) this.captured = null; },
        setRenderedWidth(width) { renderedWidth = width; },
        getBoundingClientRect() {
            if (renderedWidth === 0) return { width: 0 }; // display: none
            const custom = parseFloat(properties.get(Resizer.WIDTH_PROPERTY));
            return { width: Number.isFinite(custom) ? custom : renderedWidth };
        }
    };
    return element;
}

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
}

function createView({ width = 1600, desktop = true } = {}) {
    const listeners = new Map();
    return {
        innerWidth: width,
        matchMedia: () => ({ matches: desktop }),
        addEventListener: (type, listener) => listeners.set(type, listener),
        resize(newWidth) {
            this.innerWidth = newWidth;
            listeners.get('resize')?.();
        }
    };
}

function setup({ stored, width, desktop } = {}) {
    const sidebar = createElement();
    const handle = createElement();
    const storage = createStorage(stored === undefined ? {} : { [Resizer.STORAGE_KEY]: stored });
    const view = createView({ width, desktop });
    const api = Resizer.attach({ sidebar, handle, storage, view });
    const width_ = () => sidebar.style.getPropertyValue(Resizer.WIDTH_PROPERTY);
    return { sidebar, handle, storage, view, api, width: width_ };
}

function testClamping() {
    assert.equal(Resizer.clampWidth(100, 1600), Resizer.MIN_WIDTH);
    assert.equal(Resizer.clampWidth(5000, 1600), Resizer.MAX_WIDTH);
    assert.equal(Resizer.clampWidth(410.6, 1600), 411);
    // The player keeps at least 40% of a narrow window.
    assert.equal(Resizer.maxWidthFor(900), 540);
    assert.equal(Resizer.clampWidth(700, 900), 540);
    // A very narrow window never drops the limit below the minimum width.
    assert.equal(Resizer.maxWidthFor(200), Resizer.MIN_WIDTH);
    assert.equal(Resizer.clampWidth('abc', 1600), null);
    assert.equal(Resizer.clampWidth(NaN, 1600), null);
}

function testStoredWidth() {
    assert.equal(Resizer.readStoredWidth(createStorage({ [Resizer.STORAGE_KEY]: '400' })), 400);
    assert.equal(Resizer.readStoredWidth(createStorage({ [Resizer.STORAGE_KEY]: 'wide' })), null);
    assert.equal(Resizer.readStoredWidth(createStorage({ [Resizer.STORAGE_KEY]: '-5' })), null);
    assert.equal(Resizer.readStoredWidth(createStorage()), null);
    assert.equal(Resizer.readStoredWidth({ getItem() { throw new Error('denied'); } }), null);

    // A stored width is restored at startup.
    const restored = setup({ stored: '450' });
    assert.equal(restored.width(), '450px');
    assert.equal(restored.handle.getAttribute('aria-valuenow'), '450');

    // Without a stored width the stylesheet default applies.
    const fresh = setup();
    assert.equal(fresh.width(), '');
    assert.equal(fresh.handle.getAttribute('aria-valuenow'), '320');

    // Unavailable storage must not break resizing.
    const sidebar = createElement();
    const handle = createElement();
    const throwing = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
        removeItem() { throw new Error('denied'); }
    };
    const api = Resizer.attach({ sidebar, handle, storage: throwing, view: createView() });
    api.setWidth(380);
    assert.equal(sidebar.style.getPropertyValue(Resizer.WIDTH_PROPERTY), '380px');
}

function testPointerDrag() {
    const { sidebar, handle, storage, width } = setup();

    handle.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 320 });
    assert.equal(handle.captured, 7);
    assert.ok(sidebar.classList.contains('resizing'), 'The width transition must pause while dragging.');

    handle.dispatch('pointermove', { pointerId: 7, clientX: 420 });
    assert.equal(width(), '420px');
    assert.equal(storage.getItem(Resizer.STORAGE_KEY), null, 'Storage is written once, when the drag ends.');

    // Another pointer must not move the edge.
    handle.dispatch('pointermove', { pointerId: 8, clientX: 900 });
    assert.equal(width(), '420px');

    handle.dispatch('pointermove', { pointerId: 7, clientX: 5000 });
    assert.equal(width(), `${Resizer.MAX_WIDTH}px`);
    handle.dispatch('pointermove', { pointerId: 7, clientX: 0 });
    assert.equal(width(), `${Resizer.MIN_WIDTH}px`);
    handle.dispatch('pointermove', { pointerId: 7, clientX: 380 });

    handle.dispatch('pointerup', { pointerId: 7 });
    assert.equal(storage.getItem(Resizer.STORAGE_KEY), '380');
    assert.equal(handle.captured, null);
    assert.equal(sidebar.classList.contains('resizing'), false);
    assert.equal(handle.classList.contains('active'), false);

    // Movement after the drag ended is ignored.
    handle.dispatch('pointermove', { pointerId: 7, clientX: 500 });
    assert.equal(width(), '380px');

    // Double-click restores the stylesheet default.
    handle.dispatch('dblclick');
    assert.equal(width(), '');
    assert.equal(storage.getItem(Resizer.STORAGE_KEY), null);
}

function testDragIgnoredWhenUnavailable() {
    // The mobile drawer keeps its fixed width.
    const mobile = setup({ desktop: false });
    mobile.handle.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 320 });
    mobile.handle.dispatch('pointermove', { pointerId: 1, clientX: 500 });
    assert.equal(mobile.width(), '');

    // A collapsed sidebar cannot be resized.
    const collapsed = setup();
    collapsed.sidebar.classList.add('collapsed');
    collapsed.handle.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 320 });
    collapsed.handle.dispatch('pointermove', { pointerId: 1, clientX: 500 });
    assert.equal(collapsed.width(), '');

    // Only the primary button starts a drag.
    const secondary = setup();
    secondary.handle.dispatch('pointerdown', { button: 2, pointerId: 1, clientX: 320 });
    secondary.handle.dispatch('pointermove', { pointerId: 1, clientX: 500 });
    assert.equal(secondary.width(), '');
}

function testKeyboard() {
    const { handle, storage, width } = setup();
    const press = (key, extra = {}) => handle.dispatch('keydown', { key, ...extra });

    const handled = press('ArrowRight');
    assert.ok(handled.defaultPrevented);
    assert.ok(handled.propagationStopped, 'Handled keys must not reach the player keyboard shortcuts.');
    assert.equal(width(), '336px');
    press('ArrowRight', { shiftKey: true });
    assert.equal(width(), '400px');
    press('ArrowLeft');
    assert.equal(width(), '384px');
    assert.equal(storage.getItem(Resizer.STORAGE_KEY), '384');
    press('Home');
    assert.equal(width(), `${Resizer.MIN_WIDTH}px`);
    press('End');
    assert.equal(width(), `${Resizer.MAX_WIDTH}px`);
    press('Escape');
    assert.equal(width(), '');
    const other = press('a');
    assert.equal(other.defaultPrevented, undefined, 'Other keys must keep their default behavior.');
    assert.equal(other.propagationStopped, undefined, 'Other keys must still reach the player.');
}

function testHiddenAtStartup() {
    // App.init() runs while Home is active and Live TV is display: none.
    const sidebar = createElement(0);
    const handle = createElement();
    let observerCallback = null;
    const view = createView();
    view.ResizeObserver = class {
        constructor(callback) { observerCallback = callback; }
        observe(target) { assert.equal(target, sidebar); }
    };
    Resizer.attach({ sidebar, handle, storage: createStorage(), view });
    assert.equal(handle.getAttribute('aria-valuenow'), null, 'A hidden sidebar has no measurable width yet.');

    // Live TV becomes visible: the observer reports the laid-out width.
    sidebar.setRenderedWidth(320);
    observerCallback();
    assert.equal(handle.getAttribute('aria-valuenow'), '320');

    // Without ResizeObserver, focusing the handle refreshes the value.
    const plainSidebar = createElement(0);
    const plainHandle = createElement();
    Resizer.attach({ sidebar: plainSidebar, handle: plainHandle, storage: createStorage(), view: createView() });
    assert.equal(plainHandle.getAttribute('aria-valuenow'), null);
    plainSidebar.setRenderedWidth(320);
    plainHandle.dispatch('focus');
    assert.equal(plainHandle.getAttribute('aria-valuenow'), '320');
}

function testWindowResize() {
    const { view, storage, width } = setup({ stored: '600' });
    assert.equal(width(), '600px');

    // A narrower window clamps the width without losing the preference.
    view.resize(900);
    assert.equal(width(), '540px');
    assert.equal(storage.getItem(Resizer.STORAGE_KEY), '600');

    view.resize(1600);
    assert.equal(width(), '600px');
}

testClamping();
testStoredWidth();
testPointerDrag();
testDragIgnoredWhenUnavailable();
testKeyboard();
testHiddenAtStartup();
testWindowResize();
console.log('Channel sidebar resize tests passed.');
