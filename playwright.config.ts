import { defineConfig } from '@playwright/test';

const e2ePortText = process.env.E2E_PORT ?? '4173';
if (!/^\d{4,5}$/.test(e2ePortText)) throw new Error('E2E_PORT must be a decimal TCP port');
const e2ePort = Number(e2ePortText);
if (e2ePort < 1024 || e2ePort > 65_535) throw new Error('E2E_PORT is outside the allowed range');
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: e2eBaseUrl,
    browserName: 'chromium',
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      `pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'narrow-mobile',
      use: {
        viewport: { width: 320, height: 700 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
