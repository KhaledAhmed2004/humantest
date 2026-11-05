# HumanTest: what has been built so far

HumanTest lets people write end-to-end tests as plain sentences. A compiler turns them into normal
Playwright tests. One test can cover what the user sees, what the backend replies, and what happens
when things go wrong, with several users at once. Every run can produce a replay video that explains
itself step by step.

This document records what exists today, how the parts fit together, the decisions behind them and
what we measured along the way. For how to use it, see the [README](../README.md). For every sentence
the language understands, see [LANGUAGE.md](LANGUAGE.md).

---

## 1. Why we built it

Before writing code we compared the existing tools (Cucumber and playwright-bdd, Gauge, Robot
Framework, Katalon, testRigor, Playwright MCP and its test agents, Stagehand, Midscene). The recurring
problems were:

- **Glue code grows out of control.** In Cucumber-style tools, every sentence needs a step definition
  written in code. One reported suite had about 1,200 of them.
- **AI at run time is costly and unpredictable.** Results can change between runs, and "self-healing"
  can loosen a check until it passes, which hides real bugs.
- **Lock-in.** Several commercial tools can't export plain Playwright code. Gauge lost its sponsor.
- **Failures are hard to read.** They point at glue code, not at the sentence a person wrote.

What was missing was a **deterministic, readable language with a fixed vocabulary**. It should be
checked before it runs, compile to plain Playwright, and need no AI while tests run. That is the gap
HumanTest fills.

---

## 2. What exists today

### 2.1 The language

```
TEST "New user signup"
GIVEN the website has no users
WHEN Rahim signs up with "rahim@test.com"
THEN Rahim should see "Welcome, Rahim"
AND the admin should see 1 user
END
```

- **Two styles, which can be mixed.**
  - *Step style*, for QA: `go to signup page`, `click "Sign up"`, `backend should reply 201`.
  - *Story style*, for everyone: `TEST`, `GIVEN/WHEN/THEN/AND`, `END`.
- **Phrases** (`e2e/phrases/*.ht`) define story sentences using step sentences, not code. When the UI
  changes, only the phrase needs fixing.
- **Forgiving grammar.** Case doesn't matter, `the` and `button` are optional, verbs can be in
  third person (`the dentist clicks …`), and a step can start with a user's name.
- **Checked before running.** Unknown sentences, users, pages and states are reported with the line
  and a "did you mean" fix. For example, `clik "Sign up"` gives *Did you mean: click "Sign up"*.
- `npm run explain` prints what HumanTest understood, line by line.

Vocabulary areas (full list in [LANGUAGE.md](LANGUAGE.md)):

| Area | Examples |
|---|---|
| Browser actions | `go to`, `reload`, `type … in`, `click`, `choose "X" for Field`, `press Escape`, `fill in today's date in` |
| Parts of the page | `in "Selected tooth", click "Add issue"` (dialog, panel, form …) |
| Checks | `should see`, `should not see`, `should still be on`, `"X" button should be enabled / focused`, `"X" dialog should be open / closed` |
| Backend | `backend should receive POST /api/users`, `backend should reply 201`, `reply should not contain password`, `reply total should be 1`, `call GET …` |
| Simulated problems | `when the server fails on …`, `… is slow on …`, `… replies 401 on …`, `… returns an empty list`, `when the internet is off` |
| Accessibility | `the page should have no accessibility problems` (axe, WCAG 2.1 AA) |
| Data | `Start with: empty database` runs a state file that resets or seeds data |

### 2.2 The compiler (`src/compiler/`)

| File | Job |
|---|---|
| `steps.mts` | The whole vocabulary: a regex, a plain explanation and the code to emit for each sentence |
| `phrases.mts` | Loads phrases and expands them with placeholders (`<user>`, `<email>`, optional `(s)`) |
| `parser.mts` | Reads `.ht` files line by line, handles story words, users, pages and states, and reports problems |
| `generator.mts` | Writes one readable Playwright test per `Test:`, one `test.step` per sentence, labelled with its line |
| `suggest.mts` | "Did you mean" (edit distance) |

The CLI (`src/cli.mts`) offers `check`, `explain`, `build` and `run [--demo]`, with
`--project <folder>` for other projects.

### 2.3 The runtime (`src/runtime/index.ts`)

This is what the generated tests call.

- **Several users in one test.** Each user gets their own browser context (login, cookies, video).
  Users with credentials are logged in through the API.
- **Finding elements by priority.** An exact match comes first (button, link, menu item, tab, radio …),
  then a partial one. An element map in the config can override this.
- **Backend recording.** All `/api` traffic goes through a recorder, so reply bodies survive page
  navigations.
- **Simulations** use `context.route`, so the app sees real network failures.
- **Watchdog.** Even when no step checks for them, it reports 5xx replies, JavaScript and console
  errors, slow API calls and failed requests. In the demo app it found the hidden
  `GET /api/notifications → 500`.
- **Errors in plain words.** A failure shows the line, what went wrong, what the page shows instead
  and the backend activity, without Playwright's locator noise.

### 2.4 Videos and the replay (`src/runtime/replay.ts`)

Demo mode (`--demo`, or "Record video" in the UI) produces `humantest-videos/<test>/`:

- **`replay.html`.** Every user's video plays side by side and in sync, next to a stepper:
  - Each part has one status: green ✓ *Completed*, a blue ring that fills up for *In progress · 2 of 4*,
    red ✕ *Failed*. Steps inside an open part get small marks on the same rail.
  - Steps are written in **plain language** (`src/humanize.ts`). For example, `should see "X"` becomes
    *Sees "X"*, and `backend should reply 201` becomes *Server answers 201 Created*.
  - **Smart zoom.** While a step clicks, types or checks something, that user's video glides in on the
    element. The camera holds still while the next target is already in view.
  - Captions sit in a strip under each video, so they never cover the app and stay sharp at any size.
  - Keys: Space, ↑/↓ for steps, ←/→ for 5 s, `z` zoom, `c` captions, `s` steps list, `f` fullscreen.
    Hovering the timeline names the step. A failed run opens just before the failing step.
- **`<user>.mp4`**, one per user.
- **`side-by-side.mp4`**, all users with captions, for chat (when a test has several users).

Recording uses Playwright's `page.screencast`. Every frame carries the time it was painted, and ffmpeg
(`ffmpeg-static`) turns the frames into an mp4 that matches those times. Playwright's `showActions`
draws the moving cursor and the highlight. Without ffmpeg, it falls back to Playwright's own video.

### 2.5 The UI (`ui/`, served by `src/ui/server.mts`)

`npm run ui` opens a local web app (127.0.0.1 only). It is built with **React, Vite, Tailwind and
shadcn/ui**, in the same `radix-rhea` style as Dintel. Components were added through the shadcn MCP
server (`.mcp.json`).

- Tests grouped by file, with their last result, duration and the last 8 runs as dots
- Run all, one file or one test, with or without video, and Stop
- Live progress: the running test and its current step (server-sent events from the reporter)
- Test details: the error in plain words, watchdog warnings, every step marked, and the replay
- Mistakes in `.ht` files shown with "did you mean"; nothing runs until they are fixed
- The list updates by itself when a `.ht` file is edited in an editor
- A project picker (this folder plus `pilots/*`), light and dark mode, a resizable layout and a phone
  layout
- History in `.humantest/history.json`, kept across restarts

### 2.6 The Dintel pilot (`pilots/dintel/`)

This pilot tests the real Dintel app (Next.js 16, mock data in the browser) **without changing
Dintel**. It serves Dintel's existing production build.

- `tooth-issues.ht` covers three flows from Dintel's own `tooth-issues.spec.ts`: add an issue, the form
  rules, and removing an issue.
- `dental-visit.ht` is a full visit with 38 steps: find the patient, open Dental, add a caries, treat
  it, check the chart and the issues list, check accessibility twice, then reload.
- Comparison for the same three flows: **39 lines** of `.ht` plus 40 lines of reusable phrases,
  against **118 lines** of Playwright.
- Dintel has no backend yet, so the backend checks and multi-user features wait for it.

### 2.7 Quality checks

- `npm test`: 7 demo-app tests (signup, duplicate email, validation, server down, slow server,
  permissions, story style).
- `npm run ht -- run --project pilots/dintel`: 4 Dintel tests, run 3× in a row without a flaky
  result.
- `npm run ui:qa`: 25 checks of the UI in a real browser. They cover running, failing and stopped
  tests, `.ht` mistakes, live file updates, the replay, dark mode, phone width, and axe accessibility
  (WCAG 2.1 AA) in light and dark mode.

---

## 3. How the parts fit together

```
 .ht tests + phrases + humantest.config.json
            │  parser · phrases · steps  →  "did you mean" problems
            ▼
 generated Playwright specs (e2e/.generated, one test.step per sentence)
            │  npx playwright test
            ▼
 runtime: users (browser contexts) · element finding · backend recorder · simulations · watchdog
            │                                            │ demo mode: screencast frames + step times
            ▼                                            ▼
 reporter (plain console + live events)          replay.html · <user>.mp4 · side-by-side.mp4
            │
            ▼
 UI server (API + server-sent events + files)  →  React UI in the browser
```

---

## 4. Decisions and why

| Decision | Why |
|---|---|
| Compile to Playwright, not interpret | Keeps Playwright's runner, traces, reports and CI. The output is readable and can be ejected |
| A fixed vocabulary plus phrases, not free English | Nothing is guessed. Mistakes are caught before running, with no glue code |
| No AI while tests run | Results are repeatable, cost nothing extra, and nothing gets "healed" into hiding a bug |
| No hidden reloads or retries | A page that should update live but doesn't must fail, not get reloaded until it passes |
| A hand-written line parser instead of Langium | The near-English grammar is easier to keep forgiving this way |
| Screencast recording instead of `recordVideo` | Frames carry exact times (see section 5) |
| A custom replay player instead of Video.js or Vidstack | No player library syncs several videos with a step list, so that part had to be custom anyway |
| A plain-HTML replay page | It works on its own (opened from disk or zipped and shared) and inside the UI |
| One `humanize.ts` for the replay and the UI | The same plain words everywhere |

---

## 5. Measured along the way

| What | Result |
|---|---|
| Video sync with `recordVideo` and "stop − length" | **~1.5 s off.** Playwright leaves out the last ~1.4 s of the video |
| Video sync from the page's first paint | ~20–80 ms |
| Video sync with screencast frame timestamps | **~4–18 ms** |
| Screencast frame size | Always the viewport's CSS size (1280×720), even with `deviceScaleFactor` 1.5 or a larger `size`, and also through raw CDP. Recording at 1920×1080 only upscaled and made files 1.6× bigger, so it was reverted |
| Text sharpness, `recordVideo` vs screencast | The same at full size. The blur in the player came from showing 1280 px video at ~660 px |
| Smart zoom on the 38-step Dintel visit | 32 steps carry a focus box. The camera moves ~27 times, because the flow keeps jumping between the left and right of the page |

---

## 6. Bugs found and fixed

These are worth knowing about, because similar ones can come back.

- **Reply bodies lost after navigation.** Fixed by routing `/api` through a Node-side recorder.
- **Windows paths as Playwright filters.** Backslashes broke the file regex, so "Run" ran nothing.
  The UI now passes an escaped file name.
- **Video ~1.5 s ahead of the step list.** Caused by the "stop − length" start time. Fixed with
  screencast timestamps.
- **A race in Dintel's search box.** Its debounced URL update can send the page back to the list after
  a fast click. The test waits for "1 of 12 patients matches", like a person would. This is also a
  small UX risk in Dintel itself.
- **The `hidden` attribute lost to CSS** (`display: flex`), so the replay header wasn't hidden when
  embedded.
- **Contrast below WCAG** on selected rows (4.32:1), and during theme-switch animations.
- **A 117 px test list on phones**, fixed with a stacked layout.
- **Captions covering the app's buttons.** They moved to a strip under the video.
- **Overlapping captions in `side-by-side.mp4`.** Each caption now ends when that user's next step
  starts.
- **`String.replace` patterns** (`$&`) could corrupt the replay page. It now uses function replacers.

---

## 7. Known limits

- Tests run one at a time, because states reset a shared database.
- Videos are only recorded in demo mode. Normal failures rely on Playwright traces.
- Smart zoom is limited to 1280×720 source video, so text at 2× zoom is readable but not crisp.
- Dintel has no backend yet, so backend checks, simulations and multi-user flows are only shown on the
  demo app.
- The UI runs on one computer only (127.0.0.1). There is no shared server yet.
- It has been checked in Edge and Chromium. Firefox and Safari are untested.
- There are no unit tests or CI for HumanTest itself yet.

---

## 8. What's next

1. **Unit tests and CI** (GitHub Actions) for the compiler, phrases, `humanize` and the UI build.
2. **An editor in the UI** with syntax colors, autocomplete (sentences, users, pages, phrases) and live
   "did you mean".
3. **An installable package** (`npx humantest init`), so tests can live in Dintel's own repo.
4. **Team feedback.** Ask a QA or non-developer to read a `.ht` file and a replay without help.
5. When Dintel's backend arrives: backend checks, simulations and multi-user flows there.
6. Later: data tables, AI-written test drafts (reviewed, never at run time), zooming out on fast
   jumps across the page, and sharing a replay as one file.

---

## 9. History

| Commit | What |
|---|---|
| `d17b38a` | Prototype: compiler, runtime, story style and phrases, backend checks, watchdog, demo app |
| `82fda79` | Dintel pilot: dropdowns, page parts, accessibility checks, `--project` |
| `c856fa2` | Replay page with synced videos, step list and side-by-side mp4 |
| `60d5d4b` | Full dental visit test, today's date, panel checks |
| `d383e3e` | First HumanTest UI (`npm run ui`) |
| `9d58bad` | shadcn MCP server for Claude Code |
| `47b9565` | UI rebuilt with React, Vite and shadcn/ui |
| `ccc376a` | Fixes from a 25-check browser QA pass, live file updates |
| `02cd253` | Exact video sync with screencast, sharper captions, better player |
| `f418ff0` | Smart zoom |
| `c8bbf8d` | Plain-language steps, cleaner steps panel |
| `74c0dc8` | shadcn-style scrollbars |
| `dd5bbb4` | Steps timeline restyle |
| `80248ff` | Status-first stepper, like an order tracker |
