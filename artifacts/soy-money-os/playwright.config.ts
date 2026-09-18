import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E server is deliberately started in Vite's dedicated `e2e` mode.
 * The application fixture branch additionally requires VITE_E2E_FIXTURES=true.
 * Neither value is set by dev, build, or preview commands.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.PLAYWRIGHT_RETRIES !== undefined ? Number(process.env.PLAYWRIGHT_RETRIES) : (process.env.CI ? 2 : 0),
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
  },
  webServer: {
    command: 'PORT=4173 BASE_PATH=/ VITE_E2E=true VITE_E2E_FIXTURES=true pnpm exec vite --config vite.config.ts --mode e2e --host 127.0.0.1',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});