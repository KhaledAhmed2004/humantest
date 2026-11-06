# HumanTest language (v0.1)

A `.ht` file is a list of tests written as plain sentences. Indentation is only for readability.
Case doesn't matter, `the` is optional, and `#` starts a comment.

```
Test: New user signup shows up on the admin dashboard

  Start with: empty database          # prepare backend data
  Users: new visitor, admin           # each user gets their own browser

  As new visitor:
    go to signup page
    type "rahim@test.com" in email
    click "Sign up"
    backend should reply 201
    should see "Welcome, Rahim"

  As admin:
    go to users page
    should see "rahim@test.com"
```

## Structure

| Line | Meaning |
|---|---|
| `Test: <name>` | Starts a test. |
| `Start with: <state> "value" …` | Runs `e2e/states/<state-with-dashes>.ts` before the test (reset or seed data). Quoted values are passed to it. |
| `Users: a, b and c` | The users in this test. Optional; `As …:` also adds them. Each user must be listed under `users` in `humantest.config.json`. Users with an email/password are logged in automatically. |
| `As <user>:` | The steps below run as this user, in their own browser. Switch back and forth as often as you like. |

## Browser actions

| Sentence | Also accepted |
|---|---|
| `go to signup page` | `open …`, `visit …`, `go to "/any/path"` |
| `reload the page` | `refresh` |
| `type "text" in email` | `enter`/`write` … `into` … `field` |
| `click "Sign up"` | `press`, `tap`, `click "Sign up" button`, `click Sign up button` |
| `choose "Caries" for Condition` | `select`/`pick` … `from`/`in`. Works for native `<select>` and custom dropdowns (Radix, shadcn) |
| `press Escape` | `Enter`, `Tab`, `Space`, arrow keys |
| `wait 2 seconds` | |

Verbs also work in third person, so a sentence can start with a user: `the dentist clicks "Add issue"`, `the dentist reloads the page`.

### Working inside one part of the page

Start a step with `in "<name>",` to look only inside a dialog, panel, form or table with that name:

```
in "Selected tooth", click "Add issue"
in the "Add issue" dialog, choose "Caries" for Condition
in "Add issue" dialog, should see "Choose a condition"
```

The name can be part of the full name (`"Add issue"` finds the dialog "Add issue · Maxilla 11").
Names in `click` work the same way: an exact match wins, otherwise a partial one is used (`click "Actions for gingivitis"`).

Page names come from `pages` in the config. Fields are found by label, placeholder or name. Buttons and links are found by their visible name. If something can't be found that way, add it under `elements` in the config (`"Sign up": "#submit"`).

## Checking the screen

| Sentence |
|---|
| `should see "Welcome, Rahim"` |
| `should not see "Access denied"` |
| `should still be on signup page` |
| `"Sign up" button should be enabled` (or `disabled`, `visible`, `hidden`, `focused`; `again` is optional) |
| `"Add issue" dialog should be open` (or `closed`) |
| `the page should have no accessibility problems` (axe, WCAG 2.1 AA by default; see `accessibility` in the config) |

## Checking the backend

The page's API calls (anything under `apiPrefix`, default `/api`) are recorded automatically.

| Sentence | Meaning |
|---|---|
| `backend should receive POST /api/users` | Waits for the page to send this request since the last action, and remembers its reply. |
| `backend should not receive any request` | Nothing was sent since the last action (e.g. the frontend validation stopped it). |
| `call GET /api/admin/users` | Call the API directly as this user (with their login). Remembers the reply. |
| `backend should reply 201 Created` | Status of the remembered reply. The text after the number is optional. |
| `reply should contain email` / `reply should not contain password` | A field name or value appears anywhere in the reply. |
| `reply total should be 1` / `reply users[0].email should be "a@b.com"` | One field of the reply. |

### Which step made which call

After every run (with or without video), HumanTest writes `.humantest/traces/<test>.json`: each step with the API calls it caused, and the names (never the values) of their query and body fields. The UI shows these calls under each step.

A call counts toward the last step that *did* something (go to, click, type, choose, press, reload, call). Checks and waits don't send requests, so a page's data fetches that arrive during the next `should see` still count toward the `go to` that caused them.

### Logging in with a token, and keeping tests off real servers

Two settings in `humantest.config.json` for apps with a separate backend:

```json
"apiHosts": ["localhost:5000"],
"login": {
  "endpoint": "http://localhost:5000/api/v1/auth/login",
  "tokenCookie": { "name": "accessToken", "from": "data.accessToken" }
}
```

- `apiHosts`: the only hosts the page may send API calls to. A call anywhere else is blocked and fails the test, so a frontend that still points at a real server can't change its data. The login endpoint and `call …` steps are checked too.
- `login.tokenCookie`: for apps that read the token from a cookie the frontend sets itself. After logging in, HumanTest takes the token from the reply (`from` is a path like `data.accessToken`) and sets the cookie `name` on the app's address.

## Business logic behind the tests

When `humantest.config.json` says where the backend's code is, HumanTest also shows what the code does behind each step, without any AI: it reads the code (it never runs it) and writes the rules out in plain English.

```json
"source": { "backend": "../my-app/backend", "frontend": "../my-app/frontend" },
"glossary": { "isArch": "archived" }
```

For every step that clicks something (`click "Create Route"`), the button is found by its words in the page's own components (Next.js App Router), and its rules come out under **On the page, before anything is sent**:

- when it can't be used: `disabled={…}` → `"Create Route" can't be used while the number of ports is less than 2, …`
- what the browser checks first: `required`, `min`, `maxLength`, `type="email"` on the form's inputs
- the form's own schema: `useForm({ resolver: zodResolver(schema) })`
- when the page stops before sending: `if (…) { toast.error('…'); return; }` in the click or submit handler

After every run, each step's API calls are followed into the backend (Express routes, middleware, controllers, services) and three kinds of rules come out, each with the file and line it comes from:

- **Who can do it**: `auth(USER_ROLES.ADMIN)` → "Only ADMIN can do this."
- **What the request must contain**: from its Zod schema, field by field, plus custom checks.
- **When the server says no**: every `throw new ApiError(…)` with the conditions around it: "If departure port is not found, or departure port is not active, the server answers 404 Not Found: …".

A rule is **checked** (✔) when the test looks for its message with `should see "…"`; the others (○) are what the test doesn't cover. A condition HumanTest can't put into words is shown as code, never guessed. `glossary` gives plain words for names in the code.

The first time a test runs, what it relies on is saved in `e2e/logic/` (commit it, `logicDir` changes the folder). From then on, a change in that logic is reported, rule by rule ("was … / now …"), until it is accepted. Comments and formatting don't count; code outside the test's flow doesn't either.

| Command | |
|---|---|
| `npm run ht -- discover` | The rules behind every step of the last run. |
| `npm run ht -- discover "POST /api/v1/routes"` | The rules behind one API call. |
| `npm run ht -- discover --page /login --click "Sign In"` | The page's own rules for one click. |
| `npm run ht -- locate "POST /api/v1/routes"` | The code it runs through, function by function. |
| `npm run ht -- discover --changes` | What changed since the logic was accepted (no test run needed). |
| `npm run ht -- discover --check` | The same, exiting with 1 on changes: for CI. |
| `npm run ht -- discover --accept` | Accept the current logic (`--key "<file>::<test>"` for one test). |

The UI shows the same: a **Business logic** panel under the steps, a **Logic changed** mark in the test list a few seconds after someone saves a backend file, and an **Accept the change** button.

## Simulating problems

Put these **before** the action that triggers the request. They last until the end of the test, for that user.

| Sentence |
|---|
| `when the server fails on POST /api/users` (fake 500) |
| `when the server replies 401 on GET /api/me` |
| `when the server is slow on POST /api/users` (3s; or `by 5 seconds`) |
| `when GET /api/products returns an empty list` |
| `when the internet is off` / `when the internet is back` |

## Story style and phrases

Tests can also be written as a story, which is easier for non-technical readers:

```
TEST "New user signup"

GIVEN the website has no users
WHEN Rahim signs up with "rahim@test.com"
THEN Rahim should see "Welcome, Rahim"
AND Rahim should have no orders
AND the admin should see 1 user

END
```

- `TEST "name"` and `Test: name` both work. `END` is optional.
- `Given / When / Then / And / But` at the start of a line are optional and ignored.
- A step can start with the user's name: `Rahim should see "…"`, `the admin should see "…"`.
- Sentences like `Rahim signs up with "…"` are **phrases**. You define them once in `e2e/phrases/*.ht`, using normal steps (no code):

```
Phrase: <user> signs up with "<email>"
  As <user>:
    go to signup page
    type "<email>" in email
    click "Sign up"
    backend should reply 201

Phrase: admin should see <count> user(s)
  As admin:
    go to users page
    should see "Total users: <count>"

Phrase: the website has no users
  Start with: empty database
```

`<name>` is a placeholder. `(text)` is optional text (`user(s)` matches "user" and "users"). Phrases can use other phrases.
`npm run explain` shows each story line together with the steps it stands for. Captions and error messages show both too.

There is no hidden "magic": HumanTest never reloads a page or logs someone in unless a phrase or step says so.
When a page needs fresh data, write it in the phrase (`go to users page` or `reload the page`).

## The watchdog

You don't write anything for this. In every test, HumanTest also reports:

- API replies with status 5xx that the test didn't check
- JavaScript errors and console errors on the page
- API calls slower than `watchdog.slowApiMs`
- requests that failed

By default these are warnings. Set `"failTestOnWarning": true` to make them fail the test.

## Out of scope for v0.1 (on purpose)

Loops, if/else, variables and custom code inside `.ht` files. Put complex setup in a state file (`e2e/states/*.ts`).
