// Plain-language labels for HumanTest steps, for people watching a replay or reading results.
//   should see "12 patients"              → Sees "12 patients"
//   in "Selected tooth", click "Add issue" → Clicks "Add issue"   (where: Selected tooth)
//   backend should reply 201               → Server answers 201 Created
// It must stay self-contained (no imports, no outside variables): the replay page inlines it
// with humanize.toString(), and the UI imports it directly.

export function humanize(raw: string): { text: string; where?: string } {
  let t = raw.trim().replace(/\s+/g, ' ');
  let where: string | undefined;
  const scope = t.match(/^(?:in|inside|within) (?:the )?"([^"]+)"(?: (?:dialog|panel|section|region|form|table|row|menu|list))? ?[,:] ?(.+)$/i);
  if (scope) { where = scope[1]; t = scope[2]; }

  const unquote = (s: string) => s.replace(/^"|"$/g, '');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const STATUS: Record<string, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Not Logged In', 403: 'Forbidden',
    404: 'Not Found', 409: 'Conflict', 422: 'Invalid', 500: 'Server Error', 503: 'Unavailable',
  };
  const M = '(GET|POST|PUT|PATCH|DELETE) (\\S+)';
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^start with: ?(.+)$/i, (m) => `Starts with ${m[1].replace(/"/g, '')}`],
    [/^(?:go(?:es)? to|opens?|visits?|navigates? to) (?:the )?(.+)$/i, (m) => (m[1].startsWith('"/') ? `Opens ${unquote(m[1])}` : `Opens the ${unquote(m[1])}`)],
    [/^(?:reloads?|refresh(?:es)?)(?: the)?(?: page)?$/i, () => 'Reloads the page'],
    [/^(?:types?|enters?|writes?|fills? in) today(?:'s)?(?: date)? (?:in|into) (?:the )?(.+?)(?: (?:field|box|input))?$/i, (m) => `Enters today's date in ${unquote(m[1])}`],
    [/^(?:types?|enters?|writes?|fills? in) "([^"]*)" (?:in|into) (?:the )?(.+?)(?: (?:field|box|input))?$/i, (m) => `Types "${m[1]}" into ${unquote(m[2])}`],
    [/^(?:chooses?|selects?|picks?) "([^"]+)" (?:for|in|from) (?:the )?(.+?)(?: (?:field|dropdown|list|menu))?$/i, (m) => `Picks "${m[1]}" for ${unquote(m[2])}`],
    [/^(?:uploads?|attach(?:es)?) "([^"]+)"(?: (?:to|in|into|for|as) (?:the )?(.+?)(?: (?:field|input|box|area))?)?$/i, (m) => `Uploads "${m[1]}"${m[2] ? ` as ${unquote(m[2])}` : ''}`],
    [/^(?:press(?:es)?|hits?) (?:the )?(\w+)(?: key)?$/i, (m) => `Presses ${m[1]}`],
    [/^(?:clicks?|press(?:es)?|taps?) (?:on )?(?:the )?"([^"]+)"(?: (?:button|link))?$/i, (m) => `Clicks "${m[1]}"`],
    [/^(?:clicks?|press(?:es)?|taps?) (?:on )?(?:the )?(.+?) (?:button|link)$/i, (m) => `Clicks "${m[1]}"`],
    [/^(?:i )?(?:should not|shouldn't|should no longer) see "([^"]+)"$/i, (m) => `Doesn't see "${m[1]}"`],
    [/^(?:i )?(?:should )?(?:sees?|expects? to see) "([^"]+)"$/i, (m) => `Sees "${m[1]}"`],
    [/^(?:i )?should (?:still )?be on (?:the )?(.+)$/i, (m) => `Is still on the ${unquote(m[1])}`],
    [/^(?:the )?"([^"]+)"(?: (button|link|field|dialog|panel|section))? (?:should be|is) (\w+)(?: again)?$/i, (m) => {
      const name = `"${m[1]}"`;
      const kind = (m[2] ?? '').toLowerCase();
      const thing = kind ? `the ${name} ${kind}` : name;
      switch (m[3].toLowerCase()) {
        case 'visible': return `Sees ${thing}`;
        case 'open': return `${cap(thing)} opens`;
        case 'closed': return `${cap(thing)} closes`;
        case 'hidden': return kind === 'dialog' ? `${cap(thing)} closes` : `${cap(thing)} is gone`;
        case 'enabled': return `${cap(thing)} can be used`;
        case 'disabled': return `${cap(thing)} can't be used`;
        case 'focused': return kind === 'field' || !kind ? `The cursor is in ${name}` : `${cap(thing)} is selected`;
        default: return `${cap(thing)} is ${m[3]}`;
      }
    }],
    [/^(?:the )?page should (?:have no accessibility (?:problems|issues|violations)|be accessible)$/i, () => 'Checks accessibility'],
    [new RegExp(`^backend should receive ${M}$`, 'i'), (m) => `The app sends ${m[1]} ${m[2]}`],
    [/^backend should not receive any requests?$/i, () => 'Nothing is sent to the server'],
    [/^(?:backend should (?:reply|respond)(?: with)?|(?:the )?reply status should be) (\d{3})(?: .*)?$/i, (m) => `Server answers ${m[1]}${STATUS[m[1]] ? ` ${STATUS[m[1]]}` : ''}`],
    [/^(?:the )?reply should (not )?(?:contain|include|have) "?([^"]+?)"?$/i, (m) => (m[1] ? `The answer leaves out "${m[2]}"` : `The answer includes "${m[2]}"`)],
    [/^(?:the )?reply(?:'s)? ([\w.[\]]+) should be (.+)$/i, (m) => `The answer's ${m[1]} is ${m[2]}`],
    [new RegExp(`^call ${M}$`, 'i'), (m) => `Calls ${m[1]} ${m[2]} directly`],
    [new RegExp(`^when (?:the )?server fails on ${M}$`, 'i'), (m) => `Makes the server fail on ${m[1]} ${m[2]}`],
    [new RegExp(`^when (?:the )?server (?:replies|responds) (\\d{3}) on ${M}$`, 'i'), (m) => `Makes the server answer ${m[1]} on ${m[2]} ${m[3]}`],
    [new RegExp(`^when (?:the )?server is slow on ${M}(?: by (.+))?$`, 'i'), (m) => `Makes ${m[1]} ${m[2]} slow${m[3] ? ` (${m[3]})` : ''}`],
    [new RegExp(`^when ${M} returns (?:an )?empty list$`, 'i'), (m) => `Makes ${m[1]} ${m[2]} return an empty list`],
    [/^when (?:the )?internet is off$/i, () => 'Turns the internet off'],
    [/^when (?:the )?internet is (?:back(?: on)?|on)$/i, () => 'Turns the internet back on'],
    [/^wait (\d+(?:\.\d+)?) seconds?$/i, (m) => `Waits ${m[1]} s`],
  ];
  for (const [re, label] of rules) {
    const m = t.match(re);
    if (m) return { text: label(m), where };
  }
  return { text: cap(t), where };
}
