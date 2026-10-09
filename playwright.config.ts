import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4311',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1050 } },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:4311/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '4311',
      DATA_DIR: path.resolve(`.data/e2e-${Date.now()}`),
      SEED_DEMO: 'true',
      EMBEDDINGS: 'lexical',
    },
  },
});
