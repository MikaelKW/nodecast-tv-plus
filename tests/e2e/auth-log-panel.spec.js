const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Render the real Logs tab markup from index.html so the panel is tested
// against the shipped structure.
const indexHtml = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const logsTab = indexHtml.slice(
    indexHtml.indexOf('<div id="tab-logs"'),
    indexHtml.indexOf('<!-- Diagnostics Tab -->')
).replace('<div id="tab-logs" class="tab-content">', '<div id="tab-logs" class="tab-content active">');

const hostile = '<img src=x onerror="window.__xss=1">';

function entry(overrides) {
    return {
        id: 1,
        at: '2026-11-01T12:00:00.000Z',
        event: 'sign_in',
        outcome: 'failure',
        method: 'password',
        reason: 'unknown_account',
        reasonText: 'No account exists with this username.',
        userId: null,
        username: hostile,
        ip: '203.0.113.7',
        peerIp: '192.168.2.222',
        forwardedFor: ['203.0.113.7', '192.168.2.222'],
        host: 'tv.example.test',
        userAgent: `Mozilla/5.0 ${hostile}`,
        client: 'Safari 26 · iOS 26',
        flowId: null,
        ...overrides
    };
}

async function openPanel(page) {
    await page.route('**/auth-log-harness', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>${logsTab}</body></html>`
    }));
    await page.goto('/auth-log-harness');
    await page.addStyleTag({ path: path.join(__dirname, '../../public/css/main.css') });
    await page.addScriptTag({ path: path.join(__dirname, '../../public/js/components/AuthLogPanel.js') });
    await page.evaluate(({ first, second }) => {
        window.requests = [];
        window.savedSettings = [];
        const all = [first, second];
        window.API = {
            authLog: {
                list: async filters => {
                    window.requests.push(filters);
                    const matching = filters.ip ? all.filter(item => item.ip.startsWith(filters.ip)) : all;
                    const pageSize = 1;
                    const start = (filters.page - 1) * pageSize;
                    return {
                        entries: matching.slice(start, start + pageSize),
                        total: matching.length,
                        page: filters.page,
                        pageSize,
                        pages: Math.max(1, Math.ceil(matching.length / pageSize))
                    };
                }
            },
            settings: {
                get: async () => ({ authLogRetentionDays: 90, authLogMaxEntries: 50000 }),
                update: async data => {
                    window.savedSettings.push(data);
                    return { authLogRetentionDays: Math.max(1, data.authLogRetentionDays), authLogMaxEntries: data.authLogMaxEntries };
                }
            }
        };
        window.panel = new window.AuthLogPanel({ api: window.API });
        window.panel.show();
    }, {
        first: entry({}),
        second: entry({
            id: 2,
            at: '2026-11-01T11:00:00.000Z',
            outcome: 'success',
            reason: null,
            reasonText: null,
            userId: 1,
            username: 'admin',
            ip: '192.168.1.81',
            peerIp: '192.168.1.81',
            forwardedFor: [],
            method: 'password+totp',
            flowId: '6f1c2c1e-6c1d-4c6e-9d6a-2b1f3c4d5e6f'
        })
    });
}

test.use({ viewport: { width: 1400, height: 900 } });

test('the sign-in log renders untrusted text safely with details and pagination', async ({ page }) => {
    await openPanel(page);
    const rows = page.locator('#auth-log-rows .auth-log-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(hostile);
    await expect(rows.first()).toContainText('Failed');
    await expect(rows.first()).toContainText('No account exists with this username.');
    await expect(rows.first()).toContainText('203.0.113.7');
    await expect(rows.first()).toContainText('Safari 26 · iOS 26');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('#auth-log-rows img').count()).toBe(0);
    await expect(page.locator('#auth-log-page')).toHaveText('1–1 of 2');

    const details = page.locator('#auth-log-rows .auth-log-details').first();
    await expect(details).toBeHidden();
    const toggle = rows.first().getByRole('button', { name: /^Show details for / });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeVisible();
    await expect(details).toContainText('192.168.2.222');
    await expect(details).toContainText('203.0.113.7 → 192.168.2.222');
    await expect(details).toContainText('tv.example.test');
    await expect(details).toContainText('Sign-in · Password');

    // The table fits its container without horizontal scrolling.
    const overflow = await page.locator('.auth-log-table').evaluate(table =>
        table.scrollWidth - table.parentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.locator('#auth-log-next').click();
    await expect(rows.first()).toContainText('admin');
    await expect(rows.first()).toContainText('Password + authenticator');
    await expect(page.locator('#auth-log-next')).toBeDisabled();
    await expect(page.locator('#auth-log-prev')).toBeEnabled();
});

test('filters are sent to the API and an IP can be applied from a row', async ({ page }) => {
    await openPanel(page);
    await page.locator('#auth-log-rows').getByRole('button', { name: '203.0.113.7' }).click();
    await expect(page.locator('#auth-log-ip')).toHaveValue('203.0.113.7');
    await expect(page.locator('#auth-log-page')).toHaveText('1–1 of 1');

    await page.locator('#auth-log-account').fill('adm');
    await page.locator('#auth-log-outcome').selectOption('failure');
    await page.locator('#auth-log-from').fill('2026-11-01T10:00');
    await page.locator('#auth-log-filters').getByRole('button', { name: 'Apply' }).click();
    const last = await page.evaluate(() => window.requests.at(-1));
    expect(last.account).toBe('adm');
    expect(last.outcome).toBe('failure');
    expect(last.ip).toBe('203.0.113.7');
    expect(last.page).toBe(1);
    expect(Date.parse(last.from)).toBe(new Date('2026-11-01T10:00').getTime());

    await page.locator('#auth-log-reset').click();
    await expect(page.locator('#auth-log-ip')).toHaveValue('');
    const reset = await page.evaluate(() => window.requests.at(-1));
    expect(reset.ip).toBe('');
    expect(reset.account).toBe('');
});

test('retention settings load and save', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('#auth-log-retention-days')).toHaveValue('90');
    await expect(page.locator('#auth-log-max-entries')).toHaveValue('50000');
    await page.locator('#auth-log-retention-days').fill('30');
    await page.locator('#auth-log-retention').getByRole('button', { name: 'Save retention' }).click();
    await expect(page.locator('#auth-log-retention-status')).toHaveText('Retention saved.');
    expect(await page.evaluate(() => window.savedSettings.at(-1))).toEqual({
        authLogRetentionDays: 30, authLogMaxEntries: 50000
    });
});
