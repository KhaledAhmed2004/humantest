import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Pilot: HumanTest against Island Hop (cp-bryen-fullStack), without changing Island Hop.
// Point ISLAND_HOP_DIR somewhere else if the app isn't at ../full-stack/cp-bryen-fullStack.
// The backend needs its local PostgreSQL. The frontend is started with the local API URL, because
// its .env.local points at a remote server; "apiHosts" in humantest.config.json blocks any call that
// still goes elsewhere (e.g. an already running dev server that was started without it).
const ht = JSON.parse(fs.readFileSync(path.join(__dirname, 'humantest.config.json'), 'utf8'));
const demo = !!process.env.HUMANTEST_DEMO;
const appDir = process.env.ISLAND_HOP_DIR ?? path.resolve(__dirname, '../../../full-stack/cp-bryen-fullStack');
const api = 'http://localhost:5000/api/v1';
const port = new URL(ht.baseURL).port;

export default defineConfig({
  testDir: ht.outDir,
  fullyParallel: false,
  workers: 1,
  // The Next dev server compiles each page on its first visit.
  timeout: demo ? 180_000 : 90_000,
  expect: { timeout: 15_000 },
  reporter: [[path.join(__dirname, '../../src/reporter.ts')], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    launchOptions: { slowMo: demo ? ht.demo?.slowMo ?? 150 : 0 },
  },
  webServer: [
    {
      command: 'npm run dev',
      cwd: path.join(appDir, 'backend'),
      // Its email goes to HumanTest's test mailbox ("email" in humantest.config.json), never out.
      // These win over the backend's .env (dotenv doesn't override what is already set).
      // A backend that is already running was started without them: stop it first.
      env: { EMAIL_HOST: 'localhost', EMAIL_PORT: String(ht.email.port) },
      url: `${api}/ports`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // Next 16 refuses a second dev server for the same folder: if one already runs, put its port in baseURL.
      command: `npm run dev -- -p ${port}`,
      cwd: path.join(appDir, 'frontend'),
      url: ht.baseURL,
      env: { NEXT_PUBLIC_API_URL: api },
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
