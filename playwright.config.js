const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    // The fixture contains a single-use first-run setup. Retrying against the
    // same server would reuse mutated state and hide the original failure.
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:3210',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'chromium',
        use: {
            browserName: 'chromium',
            launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }
        }
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
