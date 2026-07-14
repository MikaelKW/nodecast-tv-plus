const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

const fixtureBaseUrl = 'http://127.0.0.1:3211';

async function waitForSync(page, sourceId) {
    await expect.poll(async () => page.evaluate(async id => {
        const response = await fetch('/api/sources/status');
        if (!response.ok) return `http-${response.status}`;
        const statuses = await response.json();
        return statuses.find(status => status.source_id === id && status.type === 'all')?.status || 'pending';
    }, sourceId), { timeout: 30_000 }).toBe('success');
}

async function scrollToBottom(page, selector) {
    return page.locator(selector).evaluate(element => {
        element.scrollTop = element.scrollHeight;
        return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop
        };
    });
}

async function expectInsideScroller(page, itemSelector, scrollerSelector) {
    const bounds = await page.evaluate(({ itemSelector, scrollerSelector }) => {
        const item = document.querySelector(itemSelector);
        const scroller = document.querySelector(scrollerSelector);
        if (!item || !scroller) return null;
        const itemRect = item.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        return {
            itemTop: itemRect.top,
            itemBottom: itemRect.bottom,
            scrollerTop: scrollerRect.top,
            scrollerBottom: scrollerRect.bottom
        };
    }, { itemSelector, scrollerSelector });

    expect(bounds).toBeTruthy();
    expect(bounds.itemTop).toBeGreaterThanOrEqual(bounds.scrollerTop - 1);
    expect(bounds.itemBottom).toBeLessThanOrEqual(bounds.scrollerBottom + 1);
}

test('mobile Safari can reach page content in portrait and landscape', async ({ page }) => {
    const password = crypto.randomBytes(24).toString('base64url');

    // A short landscape viewport must scroll before either field receives
    // focus. iOS previously inherited the app shell's body scroll lock here.
    await page.setViewportSize({ width: 874, height: 402 });
    await page.goto('/login.html');
    await expect(page.locator('#setup-message')).toHaveClass(/show/);
    const loginLayout = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        return {
            bodyOverflowY: getComputedStyle(document.body).overflowY,
            scrollHeight: document.documentElement.scrollHeight,
            innerHeight: window.innerHeight,
            scrollY: window.scrollY
        };
    });
    expect(loginLayout.bodyOverflowY).toBe('auto');
    expect(loginLayout.scrollHeight).toBeGreaterThan(loginLayout.innerHeight);
    expect(loginLayout.scrollY).toBeGreaterThan(0);
    await expect(page.locator('#password')).toBeInViewport();

    await page.setViewportSize({ width: 402, height: 874 });
    await page.locator('#username').fill('mobile-layout-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.evaluate(() => Boolean(
        window.app?.currentUser && window.app?.pages?.series
    ))).toBe(true);

    const seriesSource = await page.evaluate(async values => {
        const response = await fetch('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'xtream',
                name: 'Controlled Mobile Layout',
                url: values.url,
                username: values.username,
                password: values.password
            })
        });
        if (!response.ok) throw new Error(`Series source creation failed: ${response.status}`);
        return response.json();
    }, {
        url: `${fixtureBaseUrl}/xtream`,
        username: crypto.randomBytes(18).toString('base64url'),
        password: crypto.randomBytes(24).toString('base64url')
    });
    await waitForSync(page, seriesSource.id);

    await page.evaluate(() => window.app.navigateTo('series'));
    const controlledSeries = page.locator('.series-card', { hasText: 'Controlled Mobile Long Series' });
    await expect(controlledSeries).toBeVisible();
    await controlledSeries.click();
    await expect(page.locator('.episode-item')).toHaveCount(12);

    const seriesScroll = await scrollToBottom(page, '#series-details');
    expect(seriesScroll.scrollHeight).toBeGreaterThan(seriesScroll.clientHeight);
    expect(seriesScroll.scrollTop).toBeGreaterThan(0);
    await expectInsideScroller(page, '.episode-item:last-child', '#series-details');

    await page.evaluate(() => window.app.navigateTo('home'));
    await expect(page.locator('#page-home .dashboard-section').last()).toBeVisible();
    const homeScroll = await scrollToBottom(page, '#page-home');
    expect(homeScroll.scrollHeight).toBeGreaterThan(homeScroll.clientHeight);
    expect(homeScroll.scrollTop).toBeGreaterThan(0);
    await expectInsideScroller(page, '#page-home .dashboard-section:last-child', '#page-home');

    await page.evaluate(() => window.app.navigateTo('settings'));
    const settings = page.locator('.settings-container');
    await expect(settings).toBeVisible();
    await scrollToBottom(page, '.settings-container');
    await expectInsideScroller(page, '#tab-sources .source-section:last-child', '.settings-container');

    await page.locator('.tab[data-tab="player"]').click();
    await scrollToBottom(page, '.settings-container');
    await expect(page.locator('.shortcuts-grid')).toBeVisible();
    await expectInsideScroller(page, '.shortcuts-grid', '.settings-container');

    await page.locator('.tab[data-tab="content"]').click();
    await scrollToBottom(page, '.settings-container');
    await expectInsideScroller(page, '#content-tree', '.settings-container');

    // Compact landscape navigation must keep every destination, including
    // Logout, inside the visible viewport.
    await page.setViewportSize({ width: 874, height: 402 });
    const navLayout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        links: [...document.querySelectorAll('.navbar-menu .nav-link')].map(link => ({
            id: link.id || link.dataset.page,
            left: link.getBoundingClientRect().left,
            right: link.getBoundingClientRect().right,
            visible: getComputedStyle(link).display !== 'none'
        }))
    }));
    expect(navLayout.links.find(link => link.id === 'logout-btn')).toBeTruthy();
    expect(navLayout.links.every(link => (
        link.visible && link.left >= 0 && link.right <= navLayout.viewportWidth + 1
    ))).toBe(true);
});
