// Where a failed step's problem is: in the page (frontend), in the server (backend), in how the
// test runs (servers, config, email), or in the test itself. Read from the step, its error and the
// backend calls around it, so a failure says straight away which side to look at.

export type Part = 'frontend' | 'backend' | 'setup' | 'test';

export interface Where { part: Part; why: string }

export const PART_LABEL: Record<Part, string> = {
  frontend: '🖥️ Frontend (the page)',
  backend: '🗄️ Backend (the server)',
  setup: '⚙️ Test setup (servers, config, email)',
  test: '📝 The test itself',
};

export interface CallSeen {
  method: string;
  path: string;
  status?: number;
  /** The reply's own message ("message" in a JSON reply), when it has one. */
  reply?: string;
  /** A reply the test said to expect (`backend should reply 409`). */
  expected?: boolean;
}

const call = (c: CallSeen) => `${c.method} ${c.path} → ${c.status ?? 'no reply'}${c.reply ? ` "${c.reply}"` : ''}`;

/** The last step of a phrase ("signs up as … › backend should reply 201 Created"), without "in "X", ". */
function bare(step: string): string {
  return step.split(' › ').pop()!.replace(/^in "[^"]*"(?: \w+)?, /, '').trim();
}

export function whereProblem(stepText: string, message: string, calls: CallSeen[]): Where | undefined {
  const step = bare(stepText);
  const lower = step.toLowerCase();
  const errorCall = [...calls].reverse().find((c) => c.status !== undefined && c.status >= 400 && !c.expected);
  const serverError = calls.find((c) => (c.status ?? 0) >= 500);

  // Nothing answers at all: a server that isn't running (or is restarting after a saved file).
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(message) && /^go to /.test(lower)) {
    return { part: 'setup', why: 'The frontend didn\'t answer: it isn\'t running, or it is restarting.' };
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|no reply came back/.test(message) || (calls.length && calls.every((c) => c.status === undefined) && /Network Error/.test(message))) {
    return { part: 'backend', why: 'The backend didn\'t answer: it isn\'t running, it is restarting (a saved backend file restarts the dev server), or it crashed. Look at the backend\'s terminal.' };
  }
  if (serverError) {
    return { part: 'backend', why: `The server failed on ${call(serverError)}. The backend's log has the error.` };
  }
  if (/^Test timeout of/m.test(message)) {
    return { part: 'setup', why: 'The test ran out of time: a server was very slow, or something kept the page waiting.' };
  }

  // Before the steps: logging in, start-with states, blocked hosts.
  if (/^log in as /.test(lower) || /has no email\/password|replied 4\d\d.*\n.*(humantest\.config|refuses more logins)/.test(message)) {
    return { part: 'setup', why: /refuses more logins|429/.test(message)
      ? 'The backend refuses more logins for now (too many in a short time).'
      : 'Logging in failed: check this user\'s email and password in humantest.config.json.' };
  }
  if (/^start with: /.test(lower)) return { part: 'setup', why: 'The test data this test starts with couldn\'t be set up.' };
  if (/apiHosts|isn't allowed|blocked/i.test(message)) return { part: 'setup', why: 'A call went to a server the config doesn\'t allow (apiHosts in humantest.config.json).' };

  // Email.
  if (/No email arrived at all/.test(message)) {
    return { part: 'setup', why: 'No email reached the test mailbox, so the backend sends its email somewhere else. It was probably started without the test mailbox settings (for example your own dev server, reused by the run): stop it, or start it with EMAIL_HOST=localhost and the mailbox port.' };
  }
  if (/never arrived/.test(message)) return { part: 'backend', why: 'Other emails arrived, but not this one: the backend didn\'t send it, or sent it to another address or with another subject.' };
  if (/^The email ".*" (should|has no|should NOT)|can't find a code .* in the email/m.test(message)) return { part: 'backend', why: 'The email arrived, but what is in it is different.' };
  if (/should NOT have been sent, but it was/.test(message)) return { part: 'backend', why: 'The backend sent an email it shouldn\'t have.' };

  // The test's own wording.
  if (/Write more of the one you mean|Say which one|has no value yet|I can't read|There is no file| input: write the value as /.test(message)) {
    return { part: 'test', why: 'The test\'s line needs fixing (see above).' };
  }

  // Requests the page should (or shouldn't) send.
  if (/never received/.test(message)) {
    return { part: 'frontend', why: 'The page never sent the request. The button may not work, the page\'s own check may have stopped the form, or the click came before the page was ready.' };
  }
  if (/Expected no backend request, but the page sent/.test(message)) {
    return { part: 'frontend', why: 'The page sent a request it shouldn\'t have: its own check didn\'t stop the form.' };
  }

  // What the backend replied.
  const replied = message.match(/replied (\d{3}), expected (\d{3})/);
  if (replied) {
    const [got, want] = [Number(replied[1]), Number(replied[2])];
    const reply = errorCall?.reply ?? message.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
    if (got === 429) return { part: 'backend', why: `The backend's rate limit refused it (429${reply ? `: "${reply}"` : ''}): too many of these in a short time. Wait, or restart the backend if it counts in memory.` };
    if (got >= 400 && want < 400) return { part: 'backend', why: `The backend refused it with ${got}${reply ? `: "${reply}"` : ''}. A backend rule changed, or the test's data breaks one of its rules.` };
    if (got < 400 && want >= 400) return { part: 'backend', why: `The backend accepted it (${got}), but it should have refused it with ${want}: the rule that refuses it may be missing.` };
    return { part: 'backend', why: `The backend answered ${got}, not ${want}.` };
  }
  if (/ reply (should|should NOT) contain|in the .* reply, .* is |reply has no /i.test(message)) {
    return { part: 'backend', why: 'The backend\'s reply is different from what the test expects.' };
  }
  if (/^call /.test(lower) && errorCall) return { part: 'backend', why: `The backend refused the call: ${call(errorCall)}.` };

  // What the page shows.
  if (/should (still )?(see|be on)|should be (visible|open|closed|enabled|disabled|checked)|should not see|^should|"[^"]*" (dialog|button|field|link) should/.test(lower) || /should be visible|but it isn't|should not be visible/.test(message)) {
    if (/should not see/.test(lower)) return { part: 'frontend', why: 'The page still shows it.' };
    if (errorCall) return { part: 'backend', why: `The backend refused a request, so the page shows its error instead: ${call(errorCall)}.` };
    const ok = calls.filter((c) => c.status !== undefined);
    // The call that did something (POST, PATCH …) says more than the list the page loaded after it.
    const main = [...ok].reverse().find((c) => c.method !== 'GET') ?? ok[ok.length - 1];
    if (ok.length) return { part: 'frontend', why: `The backend answered ${main.expected ? 'as the test expects' : 'fine'} (${call(main)}), but the page didn't show it. The page's code doesn't show it, or the page reloaded (a saved frontend file reloads the dev server's pages) and wiped it.` };
    return { part: 'frontend', why: 'The page didn\'t show it, and no backend call was involved.' };
  }

  // Actions on the page.
  if (/^(click|type|choose|upload|press|tick|untick|check|uncheck|select|hover|open|go to|clear)\b/.test(lower)) {
    if (/opened, but it has no option/.test(message) && !/Its options:/.test(message)) {
      return { part: errorCall ? 'backend' : 'frontend', why: errorCall
        ? `The dropdown is empty because the backend refused its data: ${call(errorCall)}.`
        : 'The dropdown was empty: its options hadn\'t loaded yet.' };
    }
    if (/has no option/.test(message)) return { part: 'frontend', why: 'The dropdown doesn\'t offer that option: the data behind it is missing, or the option is named differently now.' };
    return { part: 'frontend', why: 'The page has no such thing right now: the page changed (the test may need updating), or it hadn\'t finished loading.' };
  }
  return undefined;
}
