const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { withIsolatedReadinessApp } = require('./isolated-readiness-app');

const hostileUsername = '<img src=x onerror="window.__accountMenuInjected=1">';
const longUsername = `viewer-${'x'.repeat(180)}-end`;

async function openAccountMenu(page) {
    const toggle = page.locator('#mobile-menu-toggle');
    if (await toggle.isVisible() && !await page.locator('#navbar-menu').evaluate(menu => menu.classList.contains('active'))) {
        await toggle.click();
    }
    const popover = page.locator('#account-menu-popover');
    if (!await popover.isVisible()) await page.locator('#account-menu-trigger').click();
    await expect(popover).toBeVisible();
}

async function signIn(page, appURL, username, password) {
    await page.goto(`${appURL}/login.html`);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.waitForURL(url => !url.pathname.endsWith('/login.html'));
    await page.waitForFunction(name => window.app?.currentUser?.username === name, username);
}

async function signOut(page) {
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/login\.html\?signed_out=1$/);
}

async function expectSignedInAs(page, username, role) {
    await openAccountMenu(page);
    expect(await page.evaluate(() => window.app.currentUser.role)).toBe(role);
    await expect(page.locator('#account-menu-username')).toHaveText(username);
    await expect(page.locator('#account-menu-username')).toHaveAttribute('title', username);
    // The visible line names the menu, so screen readers announce the account
    // when focus moves to the first menu item.
    const menu = page.getByRole('menu', { name: `Username: ${username}` });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Account' })).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
}

function registerAccountMenuChecks() {
    test('account menu shows the signed-in username as text and replaces it after switching accounts', async ({ page, context, baseURL }) => {
        test.setTimeout(120_000);
        await withIsolatedReadinessApp(baseURL, async appURL => {
            const password = crypto.randomBytes(24).toString('base64url');
            const setup = await context.request.post(`${appURL}/api/auth/setup`, {
                data: { username: 'menu-admin', password, passwordConfirmation: password }
            });
            expect(setup.status()).toBe(201);
            for (const username of [hostileUsername, longUsername]) {
                const created = await context.request.post(`${appURL}/api/auth/users`, {
                    data: { username, password, passwordConfirmation: password, role: 'viewer' }
                });
                expect(created.status()).toBe(201);
            }

            await page.goto(`${appURL}/`);
            await page.waitForFunction(() => Boolean(window.app?.currentUser));
            await expectSignedInAs(page, 'menu-admin', 'admin');
            await page.getByRole('menuitem', { name: 'Account' }).click();
            await expect(page.locator('#page-account')).toHaveClass(/active/);
            await signOut(page);

            // Returning through history after sign-out must not show the
            // previous account, whether or not the browser restores the page.
            await page.goBack();
            await expect(page).toHaveURL(/\/login\.html/);
            await expect(page.getByText('menu-admin')).toHaveCount(0);

            await signIn(page, appURL, hostileUsername, password);
            await expectSignedInAs(page, hostileUsername, 'viewer');
            await expect(page.locator('#account-menu-popover img')).toHaveCount(0);
            expect(await page.evaluate(() => window.__accountMenuInjected)).toBeUndefined();
            await expect(page.locator('#account-menu-popover')).not.toContainText('menu-admin');

            // Sign out elsewhere, then simulate the browser restoring this page
            // from its back/forward cache: the stale account must not remain.
            const loggedOut = await context.request.post(`${appURL}/api/auth/logout`);
            expect(loggedOut.status()).toBe(200);
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
            await expect(page).toHaveURL(/\/login\.html$/);
            await expect(page.locator('#username')).toBeVisible();
            await expect(page.getByText(hostileUsername)).toHaveCount(0);

            await signIn(page, appURL, longUsername, password);
            await expectSignedInAs(page, longUsername, 'viewer');
            await expect(page.locator('#account-menu-popover')).not.toContainText(hostileUsername);

            const desktopViewport = page.viewportSize();
            const viewports = [desktopViewport, { width: 390, height: 844 }, { width: 844, height: 390 }];
            for (const viewport of viewports) {
                await page.setViewportSize(viewport);
                await page.reload();
                await page.waitForFunction(() => Boolean(window.app?.currentUser));
                await openAccountMenu(page);
                await page.locator('#account-menu-user').scrollIntoViewIfNeeded();
                const layout = await page.evaluate(() => {
                    const popover = document.getElementById('account-menu-popover').getBoundingClientRect();
                    const line = document.getElementById('account-menu-user');
                    // Scroll an extremely long name to its end and measure every
                    // rendered line of text against the visible area.
                    line.scrollTop = line.scrollHeight;
                    const lineBox = line.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(document.getElementById('account-menu-username'));
                    const textRects = [...range.getClientRects()];
                    const last = textRects[textRects.length - 1];
                    return {
                        viewportWidth: window.innerWidth,
                        pageWidth: document.documentElement.scrollWidth,
                        left: popover.left,
                        right: popover.right,
                        textRight: Math.max(...textRects.map(rect => rect.right)),
                        visibleRight: lineBox.left + line.clientLeft + line.clientWidth,
                        endBottom: last.bottom,
                        visibleBottom: lineBox.top + line.clientTop + line.clientHeight,
                        lineHeight: lineBox.height,
                        viewportHeight: window.innerHeight
                    };
                });
                expect(layout.left, `menu stays on screen at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(0);
                expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
                expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
                expect(layout.textRight, JSON.stringify({ viewport, layout })).toBeLessThanOrEqual(layout.visibleRight + 1);
                expect(layout.endBottom).toBeLessThanOrEqual(layout.visibleBottom + 1);
                expect(layout.lineHeight).toBeLessThan(layout.viewportHeight / 2);
                await expect(page.locator('#account-menu-username')).toBeInViewport({ ratio: 0.1 });
            }
        });
    });
}

module.exports = { registerAccountMenuChecks };
