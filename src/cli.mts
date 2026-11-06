// HumanTest command line.
//   check            find mistakes in .ht files without opening a browser
//   explain [file]   show, line by line, what HumanTest understood
//   build            write Playwright specs into the output folder
//   run [--demo]     build, then run the tests (demo = slow, captioned videos)
//   locate [request] the backend code behind an API call, e.g. "POST /api/v1/routes"
//                    (no request: every call in the last run's traces, step by step)

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { explainStep } from './compiler/steps.mts';
import { build, check, loadPhrases, loadProject, listTestFiles, parseFile, rel, type Diagnostic } from './compiler/index.mts';
import type { Project } from './compiler/project.mts';
import { discover, locate, openBackend, readTraces, writeDiscovery, type Backend, type Discovered, type Located } from './discovery/index.mts';
import type { Group } from './discovery/rules/present.mts';
import { accept, afterRun, changes, logicDir, type TestChange } from './discovery/baseline.mts';

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function printDiagnostics(diags: Diagnostic[]) {
  for (const d of diags) {
    console.log(`${c.red('✘')} ${c.bold(`${d.file}:${d.line}`)}`);
    console.log(`    ${c.dim(d.text)}`);
    console.log(`    ${d.message}`);
    if (d.hint) console.log(`    ${c.yellow('💡 ' + d.hint)}`);
    console.log('');
  }
  console.log(c.red(`${diags.length} problem(s) found. Nothing was run.`));
}

const ROLE_LABEL: Record<string, string> = {
  route: 'route', middleware: 'middleware', validation: 'validation', controller: 'controller',
  service: 'service', shared: 'shared', helper: 'helper',
};

function printLocated(project: Project, backend: Backend, l: Located, indent = '') {
  if ('problem' in l) {
    console.log(`${indent}${c.yellow('?')} ${c.bold(l.request)}  ${c.yellow(l.problem)}`);
    return;
  }
  const r = l.slice.route;
  // "backend/src/…": the backend folder's own name, not the long way there from the test project.
  const base = path.basename(path.resolve(project.root, project.config.source!.backend!));
  const src = (file: string, line: number) => c.dim(`${base}/${file}:${line}`);
  const params = Object.entries(l.params).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`${indent}${c.green('→')} ${c.bold(l.request)}  ${c.dim(`matches ${r.method} ${r.path}${params ? ` (${params})` : ''}`)}`);
  console.log(`${indent}    ${c.cyan('route'.padEnd(11))}${r.method} ${r.path}  ${src(r.file, r.line)}`);
  for (const it of l.slice.items) {
    const pad = '  '.repeat(it.depth);
    const label = c.cyan((ROLE_LABEL[it.role] ?? it.role).padEnd(11));
    const via = it.via.replace(/\(…\)$/, '');
    const name = via === it.name || via.endsWith(`.${it.name}`) || via.startsWith(`${it.name}(`) || it.name.endsWith(via)
      ? it.via : `${it.via} ${c.dim(`→ ${it.name}`)}`;
    console.log(`${indent}    ${label}${pad}${name}  ${it.repeat ? c.dim('(listed above)') : src(it.file, it.line)}`);
  }
}

function openOrExit(project: Project): Backend {
  try {
    return openBackend(project);
  } catch (e) {
    console.log(c.red(`✘ ${(e as Error).message}`));
    process.exit(1);
  }
}

/** Without "decl"/"node": those are compiler objects (huge and circular). */
const jsonOut = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'decl' || k === 'node' ? undefined : x), 1);

function printGroups(project: Project, groups: Group[], indent: string) {
  const base = path.basename(path.resolve(project.root, project.config.source!.backend!));
  for (const g of groups) {
    console.log(`${indent}${c.bold(g.title)}`);
    for (const l of g.lines) {
      const mark = l.checked === undefined ? c.dim('•') : l.checked ? c.green('✔') : c.yellow('○');
      const note = l.translated ? '' : c.yellow(' (condition shown as code: not translated)');
      console.log(`${indent}  ${mark} ${l.text}${note}  ${c.dim(`${base}/${l.source.file}:${l.source.line}`)}`);
    }
  }
}

function printDiscovered(project: Project, d: Discovered, indent = '') {
  if ('problem' in d) {
    console.log(`${indent}${c.yellow('?')} ${c.bold(d.request)}  ${c.yellow(d.problem)}`);
    return;
  }
  console.log(`${indent}${c.green('→')} ${c.bold(d.request)}  ${c.dim(`${d.route.method} ${d.route.path}`)}`);
  printGroups(project, d.groups, `${indent}    `);
}

function printChange(project: Project, t: TestChange) {
  const base = path.basename(path.resolve(project.root, project.config.source!.backend!));
  const at = (s: { file: string; line: number }) => c.dim(`${base}/${s.file}:${s.line}`);
  const when = t.acceptedAt ? c.dim(` (accepted ${new Date(t.acceptedAt).toLocaleString()})`) : '';
  if (t.status === 'same') { console.log(`${c.green('✔')} ${t.test}${when}  ${c.dim('no change')}`); return; }
  if (t.status === 'new') { console.log(`${c.cyan('+')} ${t.test}  ${c.dim('no baseline yet')}`); return; }
  const head = t.status === 'changed' ? c.yellow('⚠ business logic changed') : c.dim('code changed, rules the same');
  console.log(`\n${t.status === 'changed' ? c.yellow('⚠') : c.dim('~')} ${c.bold(t.test)}  ${head}${when}`);
  for (const r of t.requests) {
    if (r.change === 'same') continue;
    const label = { added: c.cyan('new call'), removed: c.red('no longer reached'), changed: c.yellow('changed') }[r.change];
    console.log(`  ${c.bold(r.request)}  ${label}${r.problem ? c.red(`  ${r.problem}`) : ''}`);
    if (r.change === 'removed') console.log(c.dim(`    ${r.ruleCount ?? 0} rule(s) were behind it. Run the test again to see what it reaches now.`));
    if (r.change === 'added') console.log(c.dim(`    The test now makes this call: ${r.ruleCount ?? 0} rule(s) behind it (npm run ht -- discover "${r.request}").`));
    for (const x of r.rules) {
      if (x.change === 'added') console.log(`    ${c.green('+')} ${x.after}  ${at(x.source)}`);
      else if (x.change === 'removed') console.log(`    ${c.red('−')} ${x.before}  ${at(x.source)}`);
      else {
        console.log(`    ${c.yellow('~')} was: ${x.before}`);
        console.log(`      now: ${x.after}  ${at(x.source)}`);
      }
    }
    const fns = r.functions.map((f) => `${f.name} (${f.change}${f.lastCommit ? `, ${f.lastCommit}` : ''})`);
    if (fns.length) console.log(c.dim(`    code: ${fns.join('; ')}`));
  }
}

function runDiscover(project: Project, rest: string[]) {
  const json = rest.includes('--json');
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const ki = rest.indexOf('--key');
  const key = ki >= 0 ? rest[ki + 1] : undefined;
  const words = rest.filter((a, i) => !a.startsWith('--') && !(ki >= 0 && i === ki + 1));
  const backend = openOrExit(project);

  if (flags.has('--accept')) {
    const saved = accept(project, backend, key);
    if (json) { console.log(JSON.stringify({ saved: saved.map((f) => path.relative(project.root, f)) })); return; }
    if (!saved.length) console.log(c.yellow(key ? `Nothing to accept for ${key}: run the test first.` : 'Nothing to accept: run the tests first.'));
    for (const f of saved) console.log(`${c.green('✔')} accepted ${c.dim(path.relative(project.root, f))}`);
    return;
  }
  if (flags.has('--changes') || flags.has('--check')) {
    const all = changes(project, backend);
    if (json) { console.log(JSON.stringify(all)); return; }
    if (!all.length) { console.log(c.yellow(`No accepted business logic yet (${path.relative(project.root, logicDir(project))} is empty). Run the tests, then: discover --accept`)); return; }
    for (const t of all) printChange(project, t);
    const changed = all.filter((t) => t.status === 'changed');
    console.log('');
    if (changed.length) {
      console.log(c.yellow(`${changed.length} of ${all.length} test(s) rely on business logic that changed. If the change is intended: npm run ht -- discover --accept`));
      if (flags.has('--check')) process.exit(1);
    } else {
      console.log(c.green(`✔ The business logic behind all ${all.length} test(s) is as accepted.`));
    }
    return;
  }
  if (words.length) {
    const [method, pathname] = words.join(' ').trim().split(/\s+/);
    if (!method || !pathname) { console.log(c.red('Write the request like this: discover "POST /api/v1/routes"')); process.exit(1); }
    const d = discover(project, backend, method, pathname.split('?')[0]);
    if (json) { console.log(jsonOut(d)); return; }
    printDiscovered(project, d);
    return;
  }
  const traces = readTraces(project);
  if (!traces.length) { console.log(c.yellow('No traces yet. Run the tests first (npm test), then discover again.')); return; }
  // Tests seen for the first time get their baseline here too (the UI runs this after each run).
  const { started } = afterRun(project, backend);
  if (started && !json) console.log(c.dim(`Saved the business logic of ${started} new test(s) in ${path.relative(project.root, logicDir(project))} (commit it).`));
  for (const t of traces) {
    const result = writeDiscovery(project, backend, t);
    if (json) { console.log(jsonOut(result)); continue; }
    console.log(`\n📄 ${c.bold(result.test)}  ${c.dim(result.source)}`);
    for (const st of result.steps) {
      if (!st.calls.length) continue;
      console.log(`\n  ${c.dim(String(st.line).padStart(4) + ' │')} ${st.text}`);
      for (const d of st.calls) printDiscovered(project, d, '    ');
    }
    const lines = result.steps.flatMap((s) => s.calls.flatMap((d) => ('groups' in d ? d.groups.flatMap((g) => g.lines) : [])));
    const checked = lines.filter((l) => l.checked).length;
    console.log(`\n  ${c.green(`✔ ${checked} checked by this test`)} · ${c.yellow(`○ ${lines.length - checked} not checked`)}  ${c.dim(`(saved for the UI in ${path.relative(project.root, result.file)})`)}`);
  }
}

function runLocate(project: Project, rest: string[]) {
  const json = rest.includes('--json');
  const words = rest.filter((a) => a !== '--json');
  const started = Date.now();
  const backend = openOrExit(project);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  if (words.length) {
    const [method, pathname] = words.join(' ').trim().split(/\s+/);
    if (!method || !pathname) { console.log(c.red('Write the request like this: locate "POST /api/v1/routes"')); process.exit(1); }
    const l = locate(backend, method, pathname.split('?')[0]);
    if (json) { console.log(jsonOut(l)); return; }
    printLocated(project, backend, l);
  } else {
    const traces = readTraces(project);
    if (!traces.length) { console.log(c.yellow('No traces yet. Run the tests first (npm test), then locate again.')); return; }
    for (const { trace } of traces) {
      console.log(`\n📄 ${c.bold(trace.test)}  ${c.dim(trace.source)}`);
      for (const st of trace.steps) {
        const calls = st.calls.filter((cl) => !cl.simulated);
        if (!calls.length) continue;
        console.log(`\n  ${c.dim(String(st.line).padStart(4) + ' │')} ${st.text}`);
        const done = new Set<string>();
        for (const cl of calls) {
          const key = `${cl.method} ${cl.path}`;
          if (done.has(key)) continue;
          done.add(key);
          printLocated(project, backend, locate(backend, cl.method, cl.path), '    ');
        }
      }
    }
  }
  console.log(c.dim(`\n${backend.table.routes.length} routes read from the backend code in ${took}s.`));
  for (const u of backend.table.unresolved) console.log(c.yellow(`⚠ Not understood: ${u}`));
}

function main() {
  const args = process.argv.slice(2);
  // --project <folder> runs against a test project in another folder (it has its own humantest.config.json).
  const pi = args.indexOf('--project');
  const projectDir = pi >= 0 ? path.resolve(args[pi + 1] ?? '.') : process.cwd();
  if (pi >= 0) args.splice(pi, 2);
  const [cmd = 'help', ...rest] = args;
  const project = loadProject(projectDir);

  switch (cmd) {
    case 'check': {
      const r = check(project);
      if (r.diagnostics.length) { printDiagnostics(r.diagnostics); process.exit(1); }
      const tests = r.parsed.reduce((n, p) => n + p.tests.length, 0);
      console.log(c.green(`✔ ${r.parsed.length} file(s), ${tests} test(s): everything reads fine.`));
      return;
    }

    case 'explain': {
      const files = rest.length ? rest.map((f) => path.resolve(f)) : listTestFiles(project);
      const loaded = loadPhrases(project);
      if (loaded.problems.length) printDiagnostics(loaded.problems);
      for (const file of files) {
        const p = parseFile(project, file, loaded);
        console.log(`\n📄 ${c.bold(p.relFile)}`);
        for (const t of p.tests) {
          console.log(`\n  ${c.bold(`Test: ${t.name}`)}`);
          if (t.state) {
            const shown = t.state.story ? c.bold(t.state.story.text) : t.state.text;
            console.log(`  ${c.dim(String(t.state.line).padStart(4) + ' │')} ${shown}\n${' '.repeat(9)}${c.cyan(`→ prepare data with ${rel(project, t.state.file)}${t.state.args.length ? ` (values: ${t.state.args.join(', ')})` : ''}`)}`);
          }
          for (const u of t.users) {
            const creds = project.config.users[u.name] ?? {};
            console.log(`${' '.repeat(9)}${c.cyan(`→ open a separate browser for "${u.name}"${creds.email ? `, logged in as ${creds.email}` : ' (not logged in)'}`)}`);
          }
          let lastStory: string | undefined;
          for (const st of t.steps) {
            if (st.story) {
              // Story line once, then the steps it stands for, indented.
              const key = `${st.story.line}:${st.story.text}`;
              if (key !== lastStory) {
                console.log(`  ${c.dim(String(st.story.line).padStart(4) + ' │')} ${c.bold(st.story.text)}`);
                lastStory = key;
              }
              console.log(`${' '.repeat(9)}${c.dim(`[${st.user}]`)} ${st.text}  ${c.cyan('→ ' + explainStep(st.def, st.args))}`);
              continue;
            }
            lastStory = undefined;
            console.log(`  ${c.dim(String(st.line).padStart(4) + ' │')} ${c.dim(`[${st.user}]`)} ${st.text}`);
            console.log(`${' '.repeat(9)}${c.cyan('→ ' + explainStep(st.def, st.args))}`);
          }
        }
        if (p.diagnostics.length) { console.log(''); printDiagnostics(p.diagnostics); }
      }
      console.log('');
      return;
    }

    case 'build': {
      const r = build(project);
      if (r.diagnostics.length) { printDiagnostics(r.diagnostics); process.exit(1); }
      for (const f of r.written) console.log(`${c.green('✔')} ${rel(project, f)}`);
      return;
    }

    case 'run': {
      const demo = rest.includes('--demo');
      // The shell would split "two words" again, so quote arguments that contain spaces.
      const pwArgs = rest.filter((a) => a !== '--demo' && a !== '--').map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
      const r = build(project);
      if (r.diagnostics.length) { printDiagnostics(r.diagnostics); process.exit(1); }
      if (demo) console.log(c.cyan('🎬 Demo mode: slow, captioned, with a video per user (saved in humantest-videos/).'));
      const res = spawnSync('npx', ['playwright', 'test', ...pwArgs], {
        cwd: project.root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...(demo ? { HUMANTEST_DEMO: '1' } : {}) },
      });
      if (project.config.source?.backend) {
        // The business rules behind what the tests just did, for `discover` and the UI.
        try {
          const backend = openBackend(project);
          const traces = readTraces(project);
          const flag = pi >= 0 ? ` --project ${path.relative(process.cwd(), projectDir).split(path.sep).join('/') || '.'}` : '';
          let lines = 0, checked = 0;
          for (const t of traces) {
            const d = writeDiscovery(project, backend, t);
            for (const l of d.steps.flatMap((s) => s.calls.flatMap((x) => ('groups' in x ? x.groups.flatMap((g) => g.lines) : [])))) {
              lines++;
              if (l.checked) checked++;
            }
          }
          // The first time a test runs, what it relies on becomes its baseline; later changes need accepting.
          const { started, changed } = afterRun(project, backend);
          console.log(c.dim(`Business logic behind these tests: ${lines} rules, ${checked} checked by a step. See them with: npm run ht -- discover${flag}`));
          if (started) console.log(c.dim(`Saved the business logic of ${started} new test(s) in ${path.relative(project.root, logicDir(project))} (commit it).`));
          if (changed.length) {
            console.log(c.yellow(`⚠ The business logic behind ${changed.length} test(s) changed since it was accepted:`));
            for (const t of changed) printChange(project, t);
            console.log(c.yellow(`If that is intended: npm run ht -- discover --accept${flag}`));
          }
        } catch (e) {
          console.log(c.yellow(`⚠ Could not work out the business rules: ${(e as Error).message}`));
        }
      }
      process.exit(res.status ?? 1);
    }

    case 'locate':
      runLocate(project, rest);
      return;

    case 'discover':
      runDiscover(project, rest);
      return;

    default:
      console.log(`HumanTest

  npm run check            find mistakes in your .ht files (no browser)
  npm run explain          show what HumanTest understood, line by line
  npm run build            generate Playwright specs
  npm test                 build and run all tests
  npm run demo             run slowly with captions and record a video per user
  npm run ht -- locate "POST /api/v1/routes"   the backend code behind an API call
  npm run ht -- locate     the same, for every call in the last run's traces
  npm run ht -- discover "POST /api/v1/routes" the business rules behind an API call, in plain English
  npm run ht -- discover   the same for every step of the last run, marking what the test checks
  npm run ht -- discover --changes   what changed in that logic since it was accepted (no test run)
  npm run ht -- discover --check     the same, failing (exit 1) on changes: for CI
  npm run ht -- discover --accept    accept the current logic as the new baseline (--key "<file>::<test>" for one test)

  Extra Playwright options go after --, e.g.  npm test -- --grep "signup" --headed
  Another project folder:  npm run ht -- run --project pilots/dintel`);
  }
}

main();
