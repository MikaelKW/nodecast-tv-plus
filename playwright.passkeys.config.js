const { defineConfig, devices } = require('@playwright/test');

// Passkeys need a host name rather than an IP address, so this suite opens the
// application through localhost and serves it below a base path to cover both.
const appPort = 3220;
const fixturePort = 3221;
const appOrigin = `http://localhost:${appPort}`;

module.exports = defineConfig({
    testDir: './tests/e2e-passkeys',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    use: {
        ...devices['Desktop Chrome'],
        baseURL: `${appOrigin}/nodecast/`,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'passkeys-chromium',
        use: { browserName: 'chromium' }
    }],
    webServer: {
        command: 'node tests/fixtures/environment-server.js',
        url: `${appOrigin}/nodecast/api/version`,
        env: {
            ...process.env,
            APP_ORIGIN: appOrigin,
            NODECAST_BASE_PATH: '/nodecast',
            NODECAST_TEST_APP_PORT: String(appPort),
            NODECAST_TEST_FIXTURE_PORT: String(fixturePort),
            OIDC_CALLBACK_URL: `${appOrigin}/nodecast/api/auth/oidc/callback`
        },
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000
    }
});
