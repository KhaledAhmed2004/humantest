// Turns a .ht file into a list of tests, and reports problems in plain words.
// The format is line-based on purpose: indentation is for humans, the parser doesn't depend on it.
//
// Two writing styles work, and can be mixed:
//   step style:   As new visitor:  /  click "Sign up"  /  backend should reply 201
//   story style:  TEST "..."  /  WHEN Rahim signs up with "..."  /  THEN Rahim should see "..."  /  END
// Story sentences are defined as phrases (e2e/phrases/*.ht) made of step sentences.

import fs from 'node:fs';
import path from 'node:path';
import { STEP_DEFS, matchStep, type StepArgs, type StepDef } from './steps.mts';
import { closest, suggestSentence } from './suggest.mts';
import { rel, type Project } from './project.mts';
import { expandPhrase, loadPhrases, stripComment, stripThe, type Phrase } from './phrases.mts';

export interface Diagnostic { file: string; line: number; text: string; message: string; hint?: string }
/** The story line a step came from, when it was written as a phrase. */
export interface StoryRef { line: number; text: string }
export interface StepNode { line: number; text: string; user: string; def: StepDef; args: StepArgs; story?: StoryRef }
export interface StateRef { line: number; text: string; name: string; args: string[]; file: string; story?: StoryRef }
export interface UserRef { name: string; line: number }
export interface TestCase { name: string; line: number; state?: StateRef; users: UserRef[]; steps: StepNode[] }
export interface ParsedFile { file: string; relFile: string; tests: TestCase[]; diagnostics: Diagnostic[] }

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tidy = (text: string) => text.replace(/("[^"]*")|\s+/g, (m, q) => q ?? ' ').trim();
const STORY_WORD = /^(given|when|then|and|but)\s+(.+)$/i;

/** Where a line comes from: the test file itself, or a phrase file. */
interface Origin { file: string; line: number }

export function parseFile(project: Project, file: string, loaded = loadPhrases(project)): ParsedFile {
  const source = fs.readFileSync(file, 'utf8');
  const relFile = rel(project, file);
  const diagnostics: Diagnostic[] = [];
  const tests: TestCase[] = [];
  const cfg = project.config;
  const knownUsers = Object.keys(cfg.users ?? {});
  const knownPages = Object.keys(cfg.pages ?? {});
  const phrases: Phrase[] = loaded.phrases;
  // Longest names first, so "new visitor" wins over a user called "new".
  const usersByLength = [...knownUsers].sort((a, b) => b.length - a.length);

  let test: TestCase | undefined;
  let currentUser: string | undefined;
  const stepLines = new Map<TestCase, number>();

  const report = (at: Origin, text: string, message: string, hint?: string) =>
    diagnostics.push({ file: at.file, line: at.line, text, message, hint });

  const findUser = (raw: string, at: Origin, text: string): string | undefined => {
    const name = stripThe(raw.trim().replace(/^"|"$/g, ''));
    const hit = knownUsers.find((u) => u.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const near = closest(name, knownUsers);
    report(at, text, `I don't know a user called "${name}".`,
      near ? `Did you mean "${near}"?` : `Add "${name}" under "users" in humantest.config.json. Known users: ${knownUsers.join(', ') || 'none'}.`);
    return undefined;
  };

  const addUser = (name: string, line: number) => {
    if (test && !test.users.some((u) => u.name === name)) test.users.push({ name, line });
  };

  const resolvePage = (raw: string, at: Origin, text: string): string | undefined => {
    const name = raw.trim();
    if (name.startsWith('/')) return name;
    const lower = name.toLowerCase();
    const candidates = [lower, `${lower} page`, lower.replace(/\s+page$/, '')];
    const hit = knownPages.find((p) => candidates.includes(p.toLowerCase()));
    if (hit) return cfg.pages[hit];
    const near = closest(lower, knownPages);
    report(at, text, `I don't know the page "${name}".`,
      near ? `Did you mean "${near}"?` : `Add it under "pages" in humantest.config.json, or write a path like "/signup". Known pages: ${knownPages.join(', ') || 'none'}.`);
    return undefined;
  };

  /** Add a step for `user`. Returns false if the sentence isn't a known step. */
  const addStep = (text: string, user: string | undefined, at: Origin, story?: StoryRef): boolean => {
    const hit = matchStep(text);
    if (!hit || !test) return false;
    const line = story?.line ?? at.line;
    if (!user && test.users.length === 1) user = test.users[0].name;
    if (!user) {
      report(at, text, 'Who does this step?', 'Put it under a line like  As new visitor:  or start it with a name, like  admin should see "..."');
      return true;
    }
    if (hit.def.kind === 'goTo' || hit.def.kind === 'onPage') {
      const p = resolvePage(hit.args.page, at, text);
      if (!p) return true;
      hit.args.path = p;
    }
    test.steps.push({ line, text: tidy(text), user, def: hit.def, args: hit.args, story });
    return true;
  };

  /** Handle one sentence. `story` is set when we're inside a phrase. Returns false if nothing understood it. */
  const tryLine = (text: string, at: Origin, story: StoryRef | undefined, depth: number): boolean => {
    let m: RegExpMatchArray | null;
    if (!test) return false;
    const line = story?.line ?? at.line;

    // Start with: <state> "arg"
    if ((m = text.match(/^start\s+with\s*:\s*(.+)$/i))) {
      const args = [...m[1].matchAll(/"([^"]*)"/g)].map((q) => q[1]);
      const name = m[1].replace(/"[^"]*"/g, ' ').replace(/\s+/g, ' ').trim();
      const stateFile = path.join(project.statesDir, `${slug(name)}.ts`);
      if (!fs.existsSync(stateFile)) {
        const available = fs.existsSync(project.statesDir)
          ? fs.readdirSync(project.statesDir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '').replace(/-/g, ' '))
          : [];
        const near = closest(name, available);
        report(at, text, `I don't know the starting state "${name}".`,
          near ? `Did you mean "${near}"?` : `Create ${rel(project, stateFile)} that sets up this data.`);
      }
      if (test.state) report(at, text, 'This test already has a starting state.', 'Use one "Start with:" per test.');
      test.state = { line, text, name, args, file: stateFile, story };
      return true;
    }

    // Users: a, b and c
    if ((m = text.match(/^users?\s*:\s*(.+)$/i))) {
      for (const raw of m[1].split(/\s*,\s*|\s+and\s+/i).filter(Boolean)) {
        const u = findUser(raw, at, text);
        if (u) addUser(u, line);
      }
      return true;
    }

    // As <user>:
    if ((m = text.match(/^as\s+(?:the\s+)?(.+?)\s*:$/i))) {
      const u = findUser(m[1], at, text);
      if (u) addUser(u, line);
      // Even if the user is unknown, keep going so the steps below still get checked.
      currentUser = u ?? m[1].trim();
      return true;
    }

    // A step sentence for the current user.
    if (addStep(text, currentUser, at, story)) return true;

    // Phrases and "<user> <step>" never start with Given/When/Then/And/But.
    // Those words get removed first, otherwise "WHEN Rahim" would look like a user's name.
    if (STORY_WORD.test(text)) return false;

    // One of our phrases (story sentences).
    const expanded = expandPhrase(phrases, text);
    if (expanded) {
      if (depth > 5) {
        report(at, text, 'Phrases call each other too deeply (more than 5 levels).', `Check ${expanded.phrase.file}:${expanded.phrase.line} for a phrase that uses itself.`);
        return true;
      }
      const storyRef = story ?? { line: at.line, text: tidy(text) };
      for (const l of expanded.lines) handle(l.text, { file: expanded.phrase.file, line: l.line }, storyRef, depth + 1);
      return true;
    }

    // "<user> <step>", e.g.  Rahim should see "Welcome"  /  the admin clicks ...
    const t = stripThe(text);
    for (const u of usersByLength) {
      const um = t.match(new RegExp(`^${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.+)$`, 'i'));
      if (!um) continue;
      addUser(u, line);
      if (addStep(um[1], u, at, story)) { currentUser = u; return true; }
    }
    return false;
  };

  const handle = (text: string, at: Origin, story: StoryRef | undefined, depth: number) => {
    if (!test) {
      report(at, text, 'This line is outside of a test.', 'Start every test with a line like:  Test: New user signup');
      return;
    }
    stepLines.set(test, (stepLines.get(test) ?? 0) + 1);
    // Try the sentence as written, then without Given/When/Then/And/But in front.
    // (As written first, because "when the server fails on ..." is a real step.)
    let t = text;
    for (;;) {
      if (tryLine(t, at, story, depth)) return;
      const m = t.match(STORY_WORD);
      if (!m) break;
      t = m[2];
    }
    // "Karim should see ..." where Karim isn't a known user.
    const bare = stripThe(t);
    for (let words = 1; words <= 3; words++) {
      const parts = bare.split(/\s+/);
      const who = parts.slice(0, words).join(' ');
      const rest = parts.slice(words).join(' ');
      if (rest && matchStep(rest)) {
        const near = closest(who, knownUsers);
        report(at, text, `I don't know a user called "${who}".`,
          near ? `Did you mean "${near}"?` : `Add "${who}" under "users" in humantest.config.json.`);
        return;
      }
    }

    const templates = [...STEP_DEFS.map((d) => d.template), ...phrases.map((p) => p.header)];
    let suggestion = suggestSentence(t, templates);
    // Fill <user> with the name the writer used, if it's a known user.
    const firstWord = bare.split(/\s+/)[0] ?? '';
    const who = knownUsers.find((u) => u.toLowerCase() === firstWord.toLowerCase());
    if (suggestion && who) suggestion = suggestion.replace(/<user>/i, who);
    report(at, text, "I don't understand this line.",
      suggestion ? `Did you mean:  ${suggestion}` : 'Run "npm run explain" or see docs/LANGUAGE.md for the sentences I know. You can also define it as a Phrase in e2e/phrases/.');
  };

  source.split(/\r?\n/).forEach((rawLine, i) => {
    const at = { file: relFile, line: i + 1 };
    const text = stripComment(rawLine).trim();
    if (!text) return;
    let m: RegExpMatchArray | null;

    // Test: <name>   or   TEST "<name>"
    if ((m = text.match(/^test\s*(?::\s*|\s+(?="))(.+)$/i))) {
      test = { name: m[1].trim().replace(/^"|"$/g, ''), line: at.line, users: [], steps: [] };
      tests.push(test);
      currentUser = undefined;
      return;
    }
    // END  /  END TEST
    if (/^end(\s+test)?$/i.test(text)) {
      if (!test) report(at, text, 'END without a test above it.');
      test = undefined;
      currentUser = undefined;
      return;
    }
    handle(text, at, undefined, 0);
  });

  for (const t of tests) {
    if (!stepLines.get(t)) report({ file: relFile, line: t.line }, `Test: ${t.name}`, `The test "${t.name}" has no steps.`);
  }
  const seen = new Set<string>();
  for (const t of tests) {
    if (seen.has(t.name)) report({ file: relFile, line: t.line }, `Test: ${t.name}`, `Two tests are called "${t.name}".`, 'Give each test its own name.');
    seen.add(t.name);
  }

  return { file, relFile, tests, diagnostics };
}
