const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e-subpath',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:3212/nodecast',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'subpath-chromium',
        use: { browserName: 'chromium' }
    }],
    webServer: [
        {
            command: 'node tests/fixtures/environment-server.js',
            url: 'http://127.0.0.1:3210/api/version',
            env: {
                ...process.env,
                NODECAST_BASE_PATH: '/nodecast',
                OIDC_CALLBACK_URL: 'http://127.0.0.1:3212/nodecast/api/auth/oidc/callback'
            },
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 120_000
        },
        {
            command: 'node tests/fixtures/subpath-proxy.js',
            url: 'http://127.0.0.1:3212/nodecast/api/version',
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 120_000
        }
    ]
});
