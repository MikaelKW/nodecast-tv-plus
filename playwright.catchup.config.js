const { defineConfig, devices } = require('@playwright/test');

// Provider catch-up runs against the shared fixture server on its own ports,
// using an Xtream account that the fixture gives a TV archive.
const appPort = 3230;
const fixturePort = 3231;

module.exports = defineConfig({
    testDir: './tests/e2e-catchup',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${appPort}`,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure'
    },
    projects: [{
        name: 'catchup-chromium',
        use: {
            browserName: 'chromium',
            launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }
        }
    }],
    webServer: {
        command: 'node tests/fixtures/environment-server.js',
        url: `http://127.0.0.1:${appPort}/api/version`,
        env: {
            ...process.env,
            NODECAST_TEST_APP_PORT: String(appPort),
            NODECAST_TEST_FIXTURE_PORT: String(fixturePort)
        },
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000
    }
});
