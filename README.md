# HumanTest (prototype v0.1)

End-to-end tests written as plain sentences. HumanTest compiles them into ordinary Playwright tests.
It covers the frontend, the backend replies and the error cases in one test, with several users if needed.

```
Test: Signup when the server is down

  As new visitor:
    go to signup page
    when the server fails on POST /api/users
    type "rahim@test.com" in email
    type "Secret123" in password
    click "Sign up"

    should see "Something went wrong, please try again"
    "Sign up" button should be enabled again
```

Or as a story, for non-technical readers. The story sentences are defined once as phrases in `e2e/phrases/`:

```
TEST "New user signup"
GIVEN the website has no users
WHEN Rahim signs up with "rahim@test.com"
THEN Rahim should see "Welcome, Rahim"
AND the admin should see 1 user
END
```

## Try it

Needs Node 22.18+ (uses Node's built-in TypeScript support).

```bash
npm install
npx playwright install chromium

npm run check      # find mistakes in .ht files, no browser needed
npm run explain    # show, line by line, what HumanTest understood
npm test           # run everything (the demo app starts automatically)
npm run demo       # slow mode: captions, click highlights, one video per user
```

Extra Playwright options go after `--`, for example `npm test -- --grep "signup" --headed`.

## The HumanTest UI

```bash
npm run ui        # builds the UI, then opens http://localhost:4800 in your browser
```

Everything without the terminal:

- every test of a project, grouped by file, with its last result, its duration and its last 8 runs as dots
- **Run all**, run one file, or run one test, with or without video ("Record video")
- live progress while tests run: which test is running, and which of its steps is running right now
- for the selected test: the error in plain words, watchdog warnings, every step with ✓ / ✗ / not run,
  and the replay (videos and steps) right on the page
- mistakes in `.ht` files shown with "did you mean", before anything runs
- edit a `.ht` file in your editor and the list updates by itself (new tests, fixed mistakes)
- a project picker: this folder plus every `pilots/<name>/`
- **Output** at the bottom shows the raw Playwright output

- light and dark mode (follows your system, or use the button in the top right)

It only listens on your own computer (127.0.0.1). Results are kept in `.humantest/history.json`
inside each project, so they're still there after a restart. Options: `npm run ui -- --port 4900 --no-open`.

**Working on the UI itself.** The UI is a React app in `ui/` (Vite, Tailwind, shadcn/ui with the same
`radix-rhea` style as Dintel). Run `npm run ui` in one terminal for the server, and `npm run ui:dev`
in another for hot reload at the address Vite prints; it forwards `/api` and `/files` to the server.
Add components with `npx shadcn add <name>` inside `ui/`. The shadcn MCP server in `.mcp.json`
lets Claude Code search and add them too.

**Checking the UI after a change.** With `npm run ui` running, `npm run ui:qa` clicks through the UI in a
real browser (Edge by default, `QA_BROWSER=chrome` for Chrome) and prints PASS/FAIL for 25 checks:
running, failing and stopped tests, mistakes in `.ht` files, live file updates, the replay, dark mode,
phone width, and accessibility (axe, WCAG 2.1 AA) in light and dark mode.

## Videos and the replay page

`npm run demo` runs the tests slowly, with a caption for every step and a highlight on every click.
For each test it writes `humantest-videos/<test>/`:

- `replay.html`: open it in any browser. Every user's video plays side by side and in sync. The user
  whose step is running is highlighted. Next to the videos is the list of steps, with the backend calls
  each step made. Click a step to jump there. Space plays or pauses, ↑/↓ move between steps, and you can
  play at 0.5x to 2x. A failed test opens just before the failing step, with the error at the top.
- `<user>.mp4`: one video per user.
- `side-by-side.mp4`: all users in one video, for sharing in chat (only when a test has several users).

The folder can be zipped and sent as is. Videos need ffmpeg, which comes with the `ffmpeg-static` package.
If npm blocked its install script, run `npm install-scripts approve ffmpeg-static` and `npm rebuild ffmpeg-static`.
Without ffmpeg you still get `.webm` videos and the replay page, but jumping around in them is unreliable.
The full Playwright report with traces is available through `npx playwright show-report`.

## What's where

```
humantest.config.json   base URL, pages, users (+ logins), watchdog and demo settings
e2e/tests/*.ht          the tests: this is what people write
e2e/phrases/*.ht        story sentences ("Rahim signs up with …") defined with normal steps
e2e/states/*.ts         "Start with: …" data setups (reset/seed the backend)
e2e/.generated/         generated Playwright specs (don't edit, not committed)
src/compiler/           .ht → Playwright: steps.mts (vocabulary), parser.mts, generator.mts
src/runtime/            what generated tests call: users, backend recording, simulations, watchdog, captions
src/reporter.ts         plain-English console output
demo-app/server.mjs     a small app to test against (has one hidden bug on purpose)
docs/LANGUAGE.md        every sentence HumanTest understands
```

## How it works

1. `parser.mts` reads each line and matches it against the sentences in `steps.mts`. It checks users, pages and states against the config. Problems are reported with the line number and a "did you mean" suggestion.
2. `generator.mts` writes one Playwright test per `Test:`. Every sentence becomes one `test.step`, labelled with its `.ht` line.
3. At runtime, each user gets a separate browser context, so their logins and videos stay separate. All `/api` traffic goes through a recorder, so tests can check status codes and bodies even after the page navigates away.
4. The watchdog listens for 5xx replies, JS errors and slow calls the whole time. Failures are rewritten into: line → what went wrong → backend activity.

## Pilot: Dintel

`pilots/dintel/` tests the Dintel dental app (a sibling folder, `../dintel`) without changing it.
It serves Dintel's existing production build on port 3200.

```bash
npm run ht -- run --project pilots/dintel          # run the pilot tests
npm run ht -- run --project pilots/dintel --demo   # with captioned videos
npm run ht -- explain --project pilots/dintel
```

`pilots/dintel/e2e/tests/tooth-issues.ht` covers three flows from Dintel's own `tests/e2e/tooth-issues.spec.ts`
in 39 lines, plus 40 lines of reusable phrases. The Playwright version takes 118 lines.
Run `pnpm build` in Dintel first if its build is out of date.

## Using it on your own app

1. Set `baseURL`, `pages` and `users` in `humantest.config.json`. Remove the `webServer` block in `playwright.config.ts`, or point it at your app.
2. Give your backend a test-only way to reset and seed data. Call it from `e2e/states/*.ts`.
3. Write `.ht` files in `e2e/tests/`.

## Known limits (v0.1)

- Videos are only recorded in demo mode, not for failures in normal runs (the Playwright trace covers those).
- Tests run one at a time, because states reset a shared database.
- No VS Code extension yet (syntax highlighting, autocomplete).
- No data tables (same test with several inputs) yet.
