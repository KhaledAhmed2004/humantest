import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const ht = JSON.parse(fs.readFileSync(path.join(__dirname, 'humantest.config.json'), 'utf8'));
const demo = !!process.env.HUMANTEST_DEMO;

export default defineConfig({
  testDir: ht.outDir,
  // Tests share one backend database (states reset it), so they run one at a time.
  fullyParallel: false,
  workers: 1,
  timeout: demo ? 180_000 : 30_000,
  expect: { timeout: 5_000 },
  reporter: [['./src/reporter.ts'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    launchOptions: { slowMo: demo ? ht.demo?.slowMo ?? 200 : 0 },
  },
  webServer: {
    command: 'node demo-app/server.mjs',
    url: `${ht.baseURL}/signup`,
    reuseExistingServer: true,
  },
});
