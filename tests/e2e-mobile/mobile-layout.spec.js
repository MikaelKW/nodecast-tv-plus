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
    await expect(page.locator('#confirm-password')).toBeInViewport();

    await page.setViewportSize({ width: 402, height: 874 });
    const passwordToggle = page.locator('.password-visibility-toggle[aria-controls="password"]');
    await expect(passwordToggle).toBeVisible();
    await passwordToggle.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await expect(passwordToggle).toHaveAttribute('aria-label', 'Hide password');
    await passwordToggle.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await page.locator('#username').fill('mobile-layout-admin');
    await page.locator('#password').fill(password);
    await page.locator('#confirm-password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page).toHaveURL(/\/#mfa-onboarding$/);
    await expect.poll(() => page.evaluate(() => Boolean(
        window.app?.currentUser && window.app?.pages?.series
    ))).toBe(true);
    await expect(page.locator('#page-mfa-onboarding')).toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: 'Protect your account with MFA' })).toBeVisible();

    // The first-run prompt and its actions remain reachable in a short iPhone
    // landscape viewport before the optional Skip path is completed.
    await page.setViewportSize({ width: 874, height: 402 });
    const onboardingScroll = await scrollToBottom(page, '#page-mfa-onboarding');
    expect(onboardingScroll.scrollHeight).toBeGreaterThan(onboardingScroll.clientHeight);
    await expectInsideScroller(page, '#mfa-onboarding-skip', '#page-mfa-onboarding');
    await page.setViewportSize({ width: 402, height: 874 });

    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('dialog', { name: 'Set up MFA later' })).toBeVisible();
    await expect(page.locator('#mfa-onboarding-skip-description')).toContainText('Account security');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.locator('#mfa-onboarding-skip-dialog')).toBeHidden();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await page.getByRole('button', { name: 'Continue to NodeCast' }).click();
    await expect(page).toHaveURL(/\/#home$/);
    expect(await page.evaluate(() => NodeCastOnboarding.isMfaPending())).toBe(false);
    await page.reload();
    await expect(page).toHaveURL(/\/#home$/);
    await expect(page.locator('#page-mfa-onboarding')).not.toHaveClass(/active/);

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

    await page.locator('.tab[data-tab="interface"]').click();
    await scrollToBottom(page, '.settings-container');
    await expectInsideScroller(page, '.interface-settings-actions', '.settings-container');

    await page.locator('.tab[data-tab="content"]').click();
    await scrollToBottom(page, '.settings-container');
    await expectInsideScroller(page, '#content-tree', '.settings-container');

    await page.locator('#mobile-menu-toggle').click();
    await page.locator('#account-menu-trigger').click();
    await expect(page.locator('#account-menu-popover')).toBeVisible();
    await page.locator('#account-security-link').click();
    await expect(page.locator('#page-account')).toHaveClass(/active/);
    await expect(page.locator('#two-factor-status-badge')).toHaveText('Not enabled');
    await expect(page.getByRole('button', { name: 'Enable two-factor authentication' })).toBeVisible();
    await page.getByRole('button', { name: 'Enable two-factor authentication' }).click();
    await page.locator('#account-password').fill(password);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#totp-qr-image')).toBeVisible();
    const accountScroll = await scrollToBottom(page, '#page-account');
    expect(accountScroll.scrollHeight).toBeGreaterThan(accountScroll.clientHeight);
    expect(accountScroll.scrollTop).toBeGreaterThan(0);
    await expectInsideScroller(page, '#account-enroll-confirm-form', '#page-account');

    // Compact landscape navigation must keep every destination and the
    // account menu inside the visible viewport.
    await page.setViewportSize({ width: 874, height: 402 });
    const navLayout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        links: [...document.querySelectorAll('.navbar-menu .nav-link, #account-menu-trigger')].map(link => ({
            id: link.id || link.dataset.page,
            left: link.getBoundingClientRect().left,
            right: link.getBoundingClientRect().right,
            visible: getComputedStyle(link).display !== 'none'
        }))
    }));
    expect(navLayout.links.find(link => link.id === 'account-menu-trigger')).toBeTruthy();
    expect(navLayout.links.every(link => (
        link.visible && link.left >= 0 && link.right <= navLayout.viewportWidth + 1
    ))).toBe(true);

    // iPhone Safari does not expose the standard element fullscreen API for
    // the Live TV container. The custom control must fall back to native
    // video fullscreen instead of silently doing nothing.
    const nativeFullscreenCalls = await page.evaluate(() => {
        const player = window.app?.player;
        const fullscreenButton = document.getElementById('btn-fullscreen');
        if (!player?.container || !player?.video || !fullscreenButton) return -1;

        let calls = 0;
        Object.defineProperty(player.container, 'requestFullscreen', {
            configurable: true,
            value: undefined
        });
        Object.defineProperty(player.container, 'webkitRequestFullscreen', {
            configurable: true,
            value: undefined
        });
        Object.defineProperty(player.video, 'webkitEnterFullscreen', {
            configurable: true,
            value: () => { calls += 1; }
        });

        fullscreenButton.click();
        return calls;
    });
    expect(nativeFullscreenCalls).toBe(1);
});
