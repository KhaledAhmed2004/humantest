// HumanTest command line.
//   check            find mistakes in .ht files without opening a browser
//   explain [file]   show, line by line, what HumanTest understood
//   build            write Playwright specs into the output folder
//   run [--demo]     build, then run the tests (demo = slow, captioned videos)

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, check, loadPhrases, loadProject, listTestFiles, parseFile, rel, type Diagnostic } from './compiler/index.mts';

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

function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const project = loadProject();

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
              console.log(`${' '.repeat(9)}${c.dim(`[${st.user}]`)} ${st.text}  ${c.cyan('→ ' + st.def.explain(st.args))}`);
              continue;
            }
            lastStory = undefined;
            console.log(`  ${c.dim(String(st.line).padStart(4) + ' │')} ${c.dim(`[${st.user}]`)} ${st.text}`);
            console.log(`${' '.repeat(9)}${c.cyan('→ ' + st.def.explain(st.args))}`);
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
      const pwArgs = rest.filter((a) => a !== '--demo').map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
      const r = build(project);
      if (r.diagnostics.length) { printDiagnostics(r.diagnostics); process.exit(1); }
      if (demo) console.log(c.cyan('🎬 Demo mode: slow, captioned, with a video per user (saved in humantest-videos/).'));
      const res = spawnSync('npx', ['playwright', 'test', ...pwArgs], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...(demo ? { HUMANTEST_DEMO: '1' } : {}) },
      });
      process.exit(res.status ?? 1);
    }

    default:
      console.log(`HumanTest

  npm run check            find mistakes in your .ht files (no browser)
  npm run explain          show what HumanTest understood, line by line
  npm run build            generate Playwright specs
  npm test                 build and run all tests
  npm run demo             run slowly with captions and record a video per user

  Extra Playwright options go after --, e.g.  npm test -- --grep "signup" --headed`);
  }
}

main();
