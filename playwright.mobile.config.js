const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e-mobile',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    use: {
        ...devices['iPhone 17 Pro'],
        baseURL: 'http://127.0.0.1:3210',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'mobile-webkit',
        use: { browserName: 'webkit' }
    }],
    webServer: {
        command: 'node tests/fixtures/environment-server.js',
        url: 'http://127.0.0.1:3210/api/version',
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000
    }
});
