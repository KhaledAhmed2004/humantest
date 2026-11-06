// A plain-English console reporter for HumanTest.
// With HUMANTEST_EVENTS=1 (set by the HumanTest UI) it also prints one JSON event per line,
// prefixed with @@HT@@, so the UI can follow a run live.
import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import type { Trace, TraceCall } from './runtime';

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const EVENTS = !!process.env.HUMANTEST_EVENTS;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
/** HumanTest's own steps are titled "line N · ...". */
const isHumanStep = (s: TestStep) => s.category === 'test.step' && /^line \d+ · /.test(s.title);

function emit(event: Record<string, unknown>) {
  if (EVENTS) process.stdout.write(`@@HT@@${JSON.stringify(event)}\n`);
}

const id = (test: TestCase) => ({ spec: path.basename(test.location.file), title: test.title });

/**
 * The API calls of each step, from the runtime's trace file, in the order of `steps`.
 * Steps are matched by title, in order, so a step that appears twice gets its own calls each time.
 */
function callsPerStep(traceFile: string | undefined, steps: TestStep[]): (TraceCall[] | undefined)[] {
  if (!traceFile) return steps.map(() => undefined);
  let trace: Trace;
  try { trace = JSON.parse(fs.readFileSync(path.resolve(traceFile), 'utf8')); } catch { return steps.map(() => undefined); }
  const pool = [...trace.steps];
  return steps.map((s) => {
    const i = pool.findIndex((t) => t.title === s.title);
    return i < 0 ? undefined : pool.splice(i, 1)[0].calls;
  });
}

export default class HumanReporter implements Reporter {
  private passed = 0;
  private failed = 0;
  private warnings = 0;

  onBegin(_config: FullConfig, suite: Suite) {
    console.log(c.bold('\nHumanTest\n'));
    emit({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test: TestCase) {
    emit({ type: 'test-begin', ...id(test) });
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep) {
    if (isHumanStep(step)) emit({ type: 'step', ...id(test), step: step.title });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // On a retry, only the final attempt counts.
    if (result.status !== 'passed' && result.retry < test.retries) return;
    const annotations = [...test.annotations, ...((result as any).annotations ?? [])];
    const source = annotations.find((a) => a.type === 'source')?.description ?? '';
    const watchdog = [...new Set(annotations.filter((a) => a.type === 'watchdog').map((a) => a.description ?? ''))];
    const secs = (result.duration / 1000).toFixed(1);
    const humanSteps = result.steps.filter(isHumanStep);
    const traceFile = annotations.find((a) => a.type === 'trace')?.description;
    const calls = callsPerStep(traceFile, humanSteps);

    emit({
      type: 'test-end',
      ...id(test),
      status: result.status,
      duration: result.duration,
      errors: result.errors.map((e) => stripAnsi(e.message ?? String(e.value))),
      watchdog,
      replay: annotations.find((a) => a.type === 'replay')?.description,
      sideBySide: annotations.find((a) => a.type === 'video')?.description?.replace(/^.*?: /, ''),
      trace: traceFile,
      steps: humanSteps.map((s, i) => ({
        title: s.title,
        status: s.error ? 'failed' : 'passed',
        duration: s.duration,
        error: s.error ? stripAnsi(s.error.message ?? '') : undefined,
        calls: calls[i],
      })),
    });

    if (result.status === 'passed') {
      this.passed++;
      console.log(`${c.green('✔')} ${test.title}  ${c.dim(`${secs}s · ${source}`)}`);
    } else {
      this.failed++;
      console.log(`${c.red('✘')} ${c.bold(test.title)}  ${c.dim(`${secs}s · ${source}`)}`);
      for (const err of result.errors) {
        console.log(`\n${(err.message ?? String(err.value)).split('\n').map((l) => `   ${l}`).join('\n')}\n`);
      }
    }

    if (watchdog.length) {
      this.warnings += watchdog.length;
      console.log(c.yellow(`   ⚠ The watchdog noticed ${watchdog.length} hidden problem(s):`));
      for (const w of watchdog) console.log(c.yellow(`      • ${w}`));
    }
    for (const v of new Set(annotations.filter((a) => a.type === 'video').map((a) => a.description))) console.log(c.dim(`   🎬 ${v}`));
    for (const r of new Set(annotations.filter((a) => a.type === 'replay').map((a) => a.description))) console.log(`   ▶ Replay: ${r}`);
  }

  onEnd(result: FullResult) {
    const parts = [c.green(`${this.passed} passed`)];
    if (this.failed) parts.push(c.red(`${this.failed} failed`));
    if (this.warnings) parts.push(c.yellow(`${this.warnings} watchdog warning(s)`));
    console.log(`\n${parts.join(' · ')}`);
    console.log(c.dim('Full report with traces: npx playwright show-report\n'));
    if (result.status === 'timedout') console.log(c.red('The run timed out.'));
    emit({ type: 'end', status: result.status });
  }

  printsToStdio() {
    return true;
  }
}
