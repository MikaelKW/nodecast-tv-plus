const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

test('the application remains inside its configured reverse-proxy path', async ({ page, request }) => {
    const configuredPathResponse = await request.get('http://127.0.0.1:3210/nodecast/api/version');
    expect(configuredPathResponse.ok()).toBe(true);
    expect((await configuredPathResponse.json()).version).toMatch(/^\d+\.\d+\.\d+$/);

    const trailingSlashResponse = await request.get('http://127.0.0.1:3210/nodecast', {
        maxRedirects: 0
    });
    expect(trailingSlashResponse.status()).toBe(308);
    expect(trailingSlashResponse.headers().location).toBe('/nodecast/');

    const localRequestsOutsideBasePath = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://127.0.0.1:3212' &&
            url.pathname !== '/nodecast' &&
            !url.pathname.startsWith('/nodecast/')) {
            localRequestsOutsideBasePath.push(url.pathname);
        }
    });

    const password = crypto.randomBytes(24).toString('base64url');
    await page.goto('/nodecast');
    await expect(page).toHaveURL(/\/nodecast\/login\.html$/);
    await expect(page.locator('#setup-message')).toHaveClass(/show/);
    await page.locator('#username').fill('subpath-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();

    await expect(page).toHaveURL(/\/nodecast\/$/);
    await expect(page.getByText('NodeCast TV Plus', { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
        basePath: window.NodeCastUrl?.basePath,
        user: window.app?.currentUser?.username
    }))).toEqual({ basePath: '/nodecast', user: 'subpath-admin' });

    const version = await page.evaluate(async () => {
        const response = await fetch(NodeCastUrl.resolve('/api/version'));
        return response.json();
    });
    expect(version.version).toMatch(/^\d+\.\d+\.\d+$/);

    await page.locator('.nav-link[data-page="settings"]').click();
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
    await page.locator('#logout-btn').click();
    await expect(page).toHaveURL(/\/nodecast\/login\.html$/);

    expect(localRequestsOutsideBasePath).toEqual([]);
});
