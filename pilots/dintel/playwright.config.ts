import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Pilot: HumanTest against the Dintel app, without changing Dintel.
// It serves Dintel's existing production build (`pnpm build` in Dintel refreshes it).
// Point DINTEL_DIR somewhere else if Dintel isn't next to this repo.
const ht = JSON.parse(fs.readFileSync(path.join(__dirname, 'humantest.config.json'), 'utf8'));
const demo = !!process.env.HUMANTEST_DEMO;
const dintelDir = process.env.DINTEL_DIR ?? path.resolve(__dirname, '../../../dintel');
const port = new URL(ht.baseURL).port;

export default defineConfig({
  testDir: ht.outDir,
  fullyParallel: false,
  workers: 1,
  timeout: demo ? 180_000 : 30_000,
  expect: { timeout: 5_000 },
  reporter: [[path.join(__dirname, '../../src/reporter.ts')], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    launchOptions: { slowMo: demo ? ht.demo?.slowMo ?? 150 : 0 },
  },
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    cwd: dintelDir,
    url: `${ht.baseURL}/patients`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
