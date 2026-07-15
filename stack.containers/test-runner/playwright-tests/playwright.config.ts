import { defineConfig, devices } from '@playwright/test';

const stackDomain = process.env.DOMAIN || 'datamancy.net';
const ignoreHttpsErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true';
const originBypassHost = process.env.PLAYWRIGHT_ORIGIN_BYPASS_HOST?.trim();
const runLabel = (process.env.PLAYWRIGHT_RUN_LABEL || '')
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, '-');
const artifactPath = (base: string) => runLabel ? `${base}/${runLabel}` : base;
const hostResolverRules = originBypassHost
  ? [`MAP ${stackDomain} ${originBypassHost}`, `MAP *.${stackDomain} ${originBypassHost}`]
  : [];

/**
 * Playwright configuration for webservices stack E2E tests
 *
 * Tests SSO flows across all Web UIs using centralized Keycloak authentication.
 */
export default defineConfig({
  testDir: './tests',

  /* Run only .spec.ts files (Playwright E2E tests, not Jest unit tests) */
  testMatch: '**/*.spec.ts',

  /* Global setup - provisions a managed Keycloak test user. */
  globalSetup: require.resolve('./auth/global-setup.ts'),

  /* Global teardown - cleans up managed Keycloak test users. */
  globalTeardown: require.resolve('./auth/global-teardown.ts'),

  /* Maximum time one test can run for */
  timeout: 60 * 1000,

  /* Run tests in files in parallel */
  fullyParallel: false,

  /* Fail the build on CI if you accidentally left test.only */
  forbidOnly: !!process.env.CI,

  /* Do not hide browser regressions behind Playwright's flaky-test retry state. */
  retries: 0,

  /* Fast suites can use multiple workers; deep suites pin PW_WORKERS=1 in package.json. */
  workers: Number(process.env.PW_WORKERS || (process.env.CI ? 2 : 4)),

  /* Reporter to use */
  reporter: [
    ['html', { outputFolder: artifactPath('playwright-report'), open: 'never' }],
    ['junit', { outputFile: `${artifactPath('test-results')}/junit.xml` }],
    ['json', { outputFile: `${artifactPath('test-results')}/results.json` }],
    ['line'], // Verbose one-line-per-test output with real-time updates
  ],

  /* Shared settings for all projects */
  use: {
    /* Base URL for tests - use full live domain even inside containers.
     * The managed runtime provides DNS resolution for the configured wildcard hosts to Caddy.
     * This ensures TLS certificates are valid and auth cookies work correctly
     */
    baseURL: process.env.BASE_URL || `https://${stackDomain}`,

    /* Keep TLS verification enabled to catch certificate issues */
    ignoreHTTPSErrors: ignoreHttpsErrors,

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',

    /* Maximum time for actions like click() */
    actionTimeout: 10 * 1000,

    /* Emulate timezone */
    timezoneId: 'UTC',

    /* Emulate locale */
    locale: 'en-US',

    /* Mirror the hardened global-setup Chromium launch path inside the container. */
    launchOptions: {
      args: [
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        ...(hostResolverRules.length > 0 ? [`--host-resolver-rules=${hostResolverRules.join(',')}`] : []),
      ],
    },
  },

  /* Configure projects for different browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Firefox disabled - not installed in container (optimization to reduce build time)
    // See stack.containers/test-runner/Containerfile
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
  ],

  /* Folder for test artifacts */
  outputDir: artifactPath('test-results'),
});
