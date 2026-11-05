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
Videos from demo mode are saved in `humantest-videos/<test>/<user>.webm`.
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

## Using it on your own app

1. Set `baseURL`, `pages` and `users` in `humantest.config.json`. Remove the `webServer` block in `playwright.config.ts`, or point it at your app.
2. Give your backend a test-only way to reset and seed data. Call it from `e2e/states/*.ts`.
3. Write `.ht` files in `e2e/tests/`.

## Known limits (v0.1)

- Each user has a separate video; they aren't merged side by side yet (planned with ffmpeg).
- Tests run one at a time, because states reset a shared database.
- No VS Code extension yet (syntax highlighting, autocomplete).
- No data tables (same test with several inputs) yet.
