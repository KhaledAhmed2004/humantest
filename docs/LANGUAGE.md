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
| `wait 2 seconds` | |

Page names come from `pages` in the config. Fields are found by label, placeholder or name. Buttons and links are found by their visible name. If something can't be found that way, add it under `elements` in the config (`"Sign up": "#submit"`).

## Checking the screen

| Sentence |
|---|
| `should see "Welcome, Rahim"` |
| `should not see "Access denied"` |
| `should still be on signup page` |
| `"Sign up" button should be enabled` (or `disabled`, `visible`, `hidden`; `again` is optional) |

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
