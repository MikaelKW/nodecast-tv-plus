const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

function registerAuthStartupChecks() {
    for (const expired of [false, true]) {
        test(`${expired ? 'rejected legacy session' : 'fresh session'} waits for authentication before protected startup`, async ({ page, context, baseURL }) => {
            const basePath = new URL(baseURL).pathname.replace(/\/$/, '');
            const root = `${basePath}/`;
            const protectedRequests = [];
            const authRequests = [];
            page.on('request', request => {
                const pathname = new URL(request.url()).pathname;
                if (pathname === `${basePath}/api/auth/session`) authRequests.push(request);
                if (pathname.startsWith(`${basePath}/api/`) &&
                    !pathname.startsWith(`${basePath}/api/auth/`) &&
                    ![`${basePath}/api/version`, `${basePath}/api/startup`].includes(pathname)) {
                    protectedRequests.push(`${request.method()} ${pathname}`);
                }
            });
            if (expired) {
                // A stale browser-side credential must not unlock constructors.
                await page.addInitScript(value => localStorage.setItem('authToken', value),
                    crypto.randomBytes(32).toString('base64url'));
            }
            let unblock;
            let reachedAuth;
            let readSession;
            const gate = new Promise(resolve => { unblock = resolve; });
            const started = new Promise(resolve => { reachedAuth = resolve; });
            const sessionRead = new Promise(resolve => { readSession = resolve; });
            await page.route(`**${basePath}/api/auth/session`, async route => {
                reachedAuth();
                await gate;
                // Read the real response before forwarding it. The browser may
                // immediately navigate away, making its response body unavailable.
                const response = await route.fetch();
                readSession({ status: response.status(), body: await response.json(), headers: response.headers() });
                await route.fulfill({ response });
            });
            try {
                await page.goto(root, { waitUntil: 'domcontentloaded' });
                await started;
                // Hold the actual auth response while scripts and constructors
                // would otherwise issue requests. The endpoint is not mocked.
                await page.waitForTimeout(300);
                expect(authRequests).toHaveLength(1);
                expect(protectedRequests).toEqual([]);
                unblock();
                const status = await sessionRead;
                expect(status.status).toBe(200);
                expect(status.body).toEqual({ authenticated: false });
                expect(status.headers['cache-control']).toBe('no-store');
                await expect(page).toHaveURL(new RegExp(`${basePath}/login\\.html$`));
                await expect(page.locator('#username')).toBeVisible();
                expect(protectedRequests).toEqual([]);
                // Closing the logged-out page must not release a lease it has
                // never requested. Observe requests through the unload event.
                await page.close();
                expect(protectedRequests).toEqual([]);
                const denied = await context.request.get(`${basePath}/api/settings`);
                expect(denied.status()).toBe(401);
            } finally {
                unblock();
            }
        });
    }
}

module.exports = { registerAuthStartupChecks };
