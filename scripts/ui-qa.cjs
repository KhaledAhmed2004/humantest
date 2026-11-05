// QA pass over the HumanTest UI in a real browser. Every check prints PASS / FAIL and the script keeps going.
// Start the UI first (npm run ui), then: npm run ui:qa
// It adds and removes temporary zz-qa-*.ht files in e2e/tests, and runs the demo-app tests.
// QA_BROWSER picks the browser channel (default msedge; chrome works too).
const ROOT = process.argv[2] ?? process.cwd();
const OUT = process.argv[3] ?? require('path').join(ROOT, 'test-results', 'ui-qa');
const { chromium } = require(ROOT + '/node_modules/playwright-core');
const AxeBuilder = require(ROOT + '/node_modules/@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push(['PASS', name, note ?? '']);
    console.log(`PASS  ${name}${note ? '  (' + note + ')' : ''}`);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]]);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 3).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const TESTS = path.join(ROOT, 'e2e', 'tests');
const idle = (p) => p.getByText('Idle', { exact: true }).waitFor({ timeout: 180000 });

async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('iframe').analyze();
  return r.violations.map((v) => `${label}: [${v.impact}] ${v.id} – ${v.help} (${v.nodes.length}× e.g. ${v.nodes[0].target.join(' ')})`);
}

require('fs').mkdirSync(require('path').dirname(OUT), { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER ?? 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ---------- 1. load ----------
  await check('1.1 page loads with title "HumanTest"', async () => {
    await page.goto('http://localhost:4800');
    await page.getByRole('button', { name: 'Run all' }).waitFor();
    assert((await page.title()) === 'HumanTest', 'title is ' + (await page.title()));
  });
  await check('1.2 test list shows all 7 demo-app tests in 3 files', async () => {
    const n = await page.getByText(/^\d+ tests$/).first().textContent();
    assert(n === '7 tests', n);
    for (const f of ['permissions.ht', 'signup.ht', 'story.ht']) assert(await page.getByText(new RegExp(f)).count() > 0, 'missing ' + f);
  });
  await check('1.3 no accessibility problems (axe, light mode)', async () => {
    const v = await axe(page, 'light');
    assert(!v.length, v.join(' | '));
  });

  // ---------- 2. filter, keyboard, selection ----------
  await check('2.1 filter narrows the list', async () => {
    await page.getByRole('searchbox', { name: 'Filter tests' }).or(page.getByLabel('Filter tests')).first().fill('server');
    const rows = page.locator('button[aria-current], main ~ * button').filter({ hasText: /Signup/ });
    const visible = await page.getByRole('button', { name: /Signup when the server is down|Signup while the server is slow/ }).count();
    const hidden = await page.getByRole('button', { name: /Regular users cannot see admin data/ }).count();
    assert(visible === 2 && hidden === 0, `matching=${visible}, non-matching still shown=${hidden}`);
    await page.getByLabel('Filter tests').fill('');
    void rows;
  });
  await check('2.2 keyboard: Tab to a test and press Enter selects it', async () => {
    const target = page.getByRole('button', { name: /Signup with an email that already exists/ });
    await target.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert((await page.locator('h1').textContent()) === 'Signup with an email that already exists', 'h1 is ' + (await page.locator('h1').textContent()));
    assert((await target.getAttribute('aria-current')) === 'true', 'selected row has no aria-current');
  });
  await check('2.3 selection survives a page reload', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Run all' }).waitFor();
    await page.waitForTimeout(500);
    assert((await page.locator('h1').textContent()) === 'Signup with an email that already exists', 'after reload h1 is ' + (await page.locator('h1').textContent()));
  });

  // ---------- 3. run one test ----------
  await check('3.1 run one test: passes, every step ✓ with a duration', async () => {
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByText(/^Running/).first().waitFor({ timeout: 10000 });
    await idle(page);
    await page.waitForTimeout(600);
    const status = await page.locator('main').getByText(/^(Passed|Failed|Timed out|Stopped)$/).first().textContent();
    assert(status === 'Passed', 'status: ' + status);
    const steps = page.locator('main ol > li[class*="grid"]');
    const n = await steps.count();
    const passed = await steps.locator('svg[aria-label="Passed"]').count();
    assert(n > 0 && n === passed, `${passed}/${n} steps passed`);
    return `${n} steps`;
  });
  await check('3.2 history dot added for that test', async () => {
    const dots = await page.getByRole('button', { name: /Signup with an email that already exists/ }).locator('[title]').count();
    assert(dots >= 1, 'no dots');
    return `${dots} dots`;
  });
  await check('3.3 Output drawer shows Playwright output', async () => {
    await page.getByRole('button', { name: /Output/ }).click();
    await page.waitForTimeout(300);
    const text = await page.locator('pre').last().textContent();
    assert(/passed/.test(text), 'output: ' + text.slice(0, 120));
    await page.getByRole('button', { name: /Output/ }).click();
  });

  // ---------- 4. a failing test ----------
  fs.writeFileSync(path.join(TESTS, 'zz-qa-fail.ht'), [
    'Test: QA check that fails on purpose',
    '  Start with: empty database',
    '  As admin:',
    '    go to users page',
    '    should see "Total users: 5"',
    '    should see "No users yet"',
  ].join('\n'));
  await check('4.1 a new .ht file shows up by itself, without reloading', async () => {
    const t0 = Date.now();
    await page.getByRole('button', { name: /QA check that fails on purpose/ }).waitFor({ timeout: 5000 });
    return `appeared after ${Date.now() - t0}ms`;
  });
  await check('4.2 failing test: Failed status, error box, red step, later steps "not run"', async () => {
    await page.getByRole('button', { name: /QA check that fails on purpose/ }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByText(/^Running/).first().waitFor({ timeout: 10000 });
    await idle(page);
    await page.waitForTimeout(600);
    const status = await page.locator('main').getByText(/^(Passed|Failed)$/).first().textContent();
    assert(status === 'Failed', 'status ' + status);
    const err = await page.getByText('What went wrong').count();
    assert(err === 1, 'no error box');
    const errText = await page.locator('[role="alert"]').filter({ hasText: 'What went wrong' }).textContent();
    assert(/Total users: 5/.test(errText) && /Total users: 0/.test(errText), 'error does not explain: ' + errText.slice(0, 200));
    assert(await page.locator('main ol svg[aria-label="Failed"]').count() === 1, 'no failed step icon');
    assert(await page.locator('main ol svg[aria-label="Not run"]').count() === 1, 'later step not marked "not run"');
    assert(await page.getByRole('button', { name: /QA check that fails on purpose/ }).locator('svg[aria-label="Failed"]').count() === 1, 'list row not marked failed');
    await page.screenshot({ path: `${OUT}-4-failed.png` });
  });
  await check('4.3 summary counts the failure', async () => {
    const t = await page.getByText(/^\d+ failed$/).first().textContent();
    assert(t === '1 failed', t);
  });

  // ---------- 5. mistakes in a .ht file ----------
  fs.writeFileSync(path.join(TESTS, 'zz-qa-typo.ht'), 'Test: QA typo\n  As new visiter:\n    clik "Sign up"\n');
  await check('5.1 mistakes are listed with "did you mean", Run is disabled', async () => {
    await page.getByRole('button', { name: /QA typo/ }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /QA typo/ }).click();
    const box = page.getByText("This file has problems, so it can't run yet");
    assert(await box.count() === 1, 'no problems box');
    const text = await page.locator('main').textContent();
    assert(/Did you mean "new visitor"/.test(text) && /click "Sign up"/.test(text), 'hints missing');
    assert(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled(), 'Run is enabled');
    assert(await page.getByRole('button', { name: /QA typo/ }).locator('svg[aria-label="Has problems"]').count() === 1, 'row not marked');
    await page.screenshot({ path: `${OUT}-5-typo.png` });
  });
  await check('5.2 Run all with a broken file shows an error toast and runs nothing', async () => {
    await page.getByRole('button', { name: 'Run all' }).click();
    const toast = page.locator('[data-sonner-toast]');
    await toast.first().waitFor({ timeout: 5000 });
    const t = await toast.first().textContent();
    assert(/problems/i.test(t), 'toast: ' + t);
    await page.waitForTimeout(800);
    assert(await page.getByText('Idle', { exact: true }).count() === 1, 'a run started anyway');
  });
  await check('5.3 fixing the file in an editor clears the problems live', async () => {
    fs.writeFileSync(path.join(TESTS, 'zz-qa-typo.ht'), 'Test: QA typo\n  As new visitor:\n    click "Sign up"\n');
    await page.getByText("This file has problems, so it can't run yet").waitFor({ state: 'detached', timeout: 5000 });
    assert(await page.getByRole('button', { name: 'Run', exact: true }).isEnabled(), 'Run still disabled');
  });
  fs.rmSync(path.join(TESTS, 'zz-qa-typo.ht'));

  // ---------- 6. stop a run, buttons disabled while running ----------
  await check('6.1 while running: Run buttons and project select are disabled', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Run all' }).waitFor();
    await page.getByRole('button', { name: 'Run all' }).click();
    await page.getByText(/^Running/).first().waitFor({ timeout: 10000 });
    assert(await page.getByRole('button', { name: 'Run', exact: true }).isDisabled(), 'Run enabled');
    assert(await page.getByRole('combobox', { name: 'Project' }).isDisabled(), 'project select enabled');
    assert(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible(), 'no Stop button');
  });
  await check('6.2 Stop ends the run and the UI goes back to Idle', async () => {
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Idle', { exact: true }).waitFor({ timeout: 30000 });
    assert(await page.getByRole('button', { name: 'Run all' }).isEnabled(), 'Run all still disabled');
    const running = await page.locator('svg[aria-label="Running…"], svg[aria-label="Waiting to run"]').count();
    assert(running === 0, `${running} tests still shown as running/waiting`);
  });
  await check('6.3 after Stop, a new run works', async () => {
    await page.getByRole('button', { name: /Regular users cannot see admin data/ }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByText(/^Running/).first().waitFor({ timeout: 10000 });
    await idle(page);
    await page.waitForTimeout(500);
    const status = await page.locator('main').getByText(/^(Passed|Failed)$/).first().textContent();
    assert(status === 'Passed', status);
  });
  fs.rmSync(path.join(TESTS, 'zz-qa-fail.ht'));

  // ---------- 7. theme, resize ----------
  await check('7.1 dark mode button switches and is remembered after reload', async () => {
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    assert(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'no dark class');
    await page.reload();
    await page.getByRole('button', { name: 'Run all' }).waitFor();
    assert(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark not remembered');
  });
  await check('7.2 no accessibility problems (axe, dark mode)', async () => {
    const v = await axe(page, 'dark');
    assert(!v.length, v.join(' | '));
    await page.screenshot({ path: `${OUT}-7-dark.png` });
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
  });
  await check('7.3 dragging the divider resizes the test list', async () => {
    const list = page.locator('[data-slot="resizable-panel"]').first();
    const before = (await list.boundingBox()).width;
    const handle = page.locator('[data-slot="resizable-handle"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
    await page.mouse.down();
    await page.mouse.move(hb.x + 160, hb.y + 200, { steps: 8 });
    await page.mouse.up();
    const after = (await list.boundingBox()).width;
    assert(after > before + 100, `width ${before} → ${after}`);
    return `${Math.round(before)}px → ${Math.round(after)}px`;
  });

  // ---------- 8. replay inside the UI ----------
  await check('8.1 run with video, then clicking a step inside the replay moves the video', async () => {
    await page.getByRole('button', { name: /New user signup \(story style\)/ }).click();
    await page.getByRole('button', { name: 'Run with video' }).click();
    await page.getByText(/^Running/).first().waitFor({ timeout: 10000 });
    await idle(page);
    await page.waitForTimeout(1500);
    const frame = page.frameLocator('iframe[title^="Replay"]');
    await frame.locator('.step').first().waitFor({ timeout: 10000 });
    const step = frame.locator('.step', { hasText: 'should see "Total users: 1"' });
    await step.click();
    await page.waitForTimeout(1200);
    const times = await frame.locator('video').evaluateAll((vs) => vs.map((v) => v.currentTime));
    assert(times.some((t) => t > 3), 'videos did not move: ' + times.join(', '));
    const headerShown = await frame.locator('header').isVisible();
    assert(!headerShown, 'replay header visible inside the UI');
    await page.screenshot({ path: `${OUT}-8-replay.png` });
    return 'video at ' + times.map((t) => t.toFixed(1) + 's').join(', ');
  });

  // ---------- 9. project switch ----------
  await check('9.1 switching to dintel shows its 4 tests and story headings', async () => {
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: 'dintel' }).click();
    await page.waitForTimeout(1200);
    const n = await page.getByText(/^\d+ tests$/).first().textContent();
    assert(n === '4 tests', n);
    await page.getByRole('button', { name: /A full dental visit/ }).click();
    assert(await page.getByText('the dentist opens the patient list').count() >= 1, 'no story heading');
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: /testing-compiler/ }).click();
  });

  // ---------- 10. small screen ----------
  await check('10.1 phone width (390px): no sideways scrolling, test list readable', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto('http://localhost:4800');
    await phone.getByRole('button', { name: 'Run all' }).waitFor();
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${OUT}-10-phone.png` });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const listWidth = (await phone.locator('[data-slot="resizable-panel"]').first().boundingBox()).width;
    await phone.close();
    assert(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    assert(listWidth >= 280, `test list is only ${Math.round(listWidth)}px wide`);
  });

  await check('11.1 no console errors during the whole session', async () => {
    const real = consoleErrors.filter((e) => !/Failed to load resource.*(409|400)/.test(e));
    assert(!real.length, real.slice(0, 3).join(' | '));
  });

  await browser.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('QA script crashed:', e); process.exit(1); });
