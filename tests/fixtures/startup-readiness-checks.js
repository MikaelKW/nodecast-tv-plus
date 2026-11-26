const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { withIsolatedReadinessApp } = require('./isolated-readiness-app');

function registerStartupReadinessChecks() {
    test('sign-in waits, backs off after 429 and becomes available automatically', async ({ page, baseURL }) => {
        const base = new URL(baseURL).pathname.replace(/\/$/, '');
        let state = 'starting';
        let count = 0;
        const authRequests = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname.startsWith(`${base}/api/auth/`)) authRequests.push(request.url());
        });
        await page.route(`**${base}/api/startup`, route => {
            count++;
            if (count === 1) return route.fulfill({ status: 429, headers: { 'Retry-After': '3' }, json: { error: 'Synthetic polling limit' } });
            return route.fulfill({ json: { state } });
        });
        await page.goto(`${base}/login.html`);
        await expect(page.locator('#startup-notice')).toBeVisible();
        expect(authRequests).toEqual([]);
        await page.waitForTimeout(1000);
        expect(count).toBe(1, 'Retry-After prevents aggressive readiness polling');
        state = 'ready';
        await expect(page.locator('#username')).toBeVisible();
        await expect(page.locator('#startup-notice')).toHaveCount(0);
        expect(authRequests.length).toBeGreaterThan(0);
        const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
        expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    });

    test('an existing session waits without protected requests or losing its cookie', async ({ page, context, baseURL }) => {
        const sharedSetup = await context.request.get(`${baseURL}/api/auth/setup-required`);
        expect(sharedSetup.status()).toBe(200);
        const sharedSetupBefore = await sharedSetup.json();
        await withIsolatedReadinessApp(baseURL, async appURL => {
            const base = new URL(baseURL).pathname.replace(/\/$/, '');
            const password = crypto.randomBytes(24).toString('base64url');
            const setup = await context.request.post(`${appURL}/api/auth/setup`, {
                data: { username: 'StartupBrowser', password, passwordConfirmation: password }
            });
            expect(setup.status()).toBe(201);
            const before = await context.cookies();
            expect(before.length).toBeGreaterThan(0);
            let state = 'starting';
            const protectedRequests = [];
            page.on('request', request => {
                const pathname = new URL(request.url()).pathname;
                if (pathname.startsWith(`${base}/api/`) && ![`${base}/api/startup`, `${base}/api/version`].includes(pathname)) protectedRequests.push(pathname);
            });
            await page.route(`**${base}/api/startup`, route => route.fulfill({ json: { state } }));
            await page.goto(`${appURL}/`);
            await expect(page.locator('#startup-notice')).toBeVisible();
            expect(protectedRequests).toEqual([]);
            expect(await context.cookies()).toEqual(before);
            state = 'degraded';
            await expect(page.locator('#startup-notice')).toHaveCount(0);
            await expect(page.locator('#logout-btn')).toBeAttached();
            await expect.poll(() => protectedRequests.includes(`${base}/api/auth/session`)).toBe(true);
            expect(new URL(page.url()).pathname).not.toContain('login.html');
            const me = await context.request.get(`${appURL}/api/auth/me`);
            expect(me.status()).toBe(200);
        });
        const sharedSetupAfter = await context.request.get(`${baseURL}/api/auth/setup-required`);
        expect(sharedSetupAfter.status()).toBe(200);
        expect(await sharedSetupAfter.json()).toEqual(sharedSetupBefore);
    });
}

module.exports = { registerStartupReadinessChecks };
