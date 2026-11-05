// A plain-English console reporter for HumanTest.
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export default class HumanReporter implements Reporter {
  private passed = 0;
  private failed = 0;
  private warnings = 0;

  onBegin() {
    console.log(c.bold('\nHumanTest\n'));
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // On a retry, only the final attempt counts.
    if (result.status !== 'passed' && result.retry < test.retries) return;
    const annotations = [...test.annotations, ...((result as any).annotations ?? [])];
    const source = annotations.find((a) => a.type === 'source')?.description ?? '';
    const watchdog = [...new Set(annotations.filter((a) => a.type === 'watchdog').map((a) => a.description ?? ''))];
    const secs = (result.duration / 1000).toFixed(1);

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
    for (const v of annotations.filter((a) => a.type === 'video')) console.log(c.dim(`   🎬 ${v.description}`));
  }

  onEnd(result: FullResult) {
    const parts = [c.green(`${this.passed} passed`)];
    if (this.failed) parts.push(c.red(`${this.failed} failed`));
    if (this.warnings) parts.push(c.yellow(`${this.warnings} watchdog warning(s)`));
    console.log(`\n${parts.join(' · ')}`);
    console.log(c.dim('Full report with traces: npx playwright show-report\n'));
    if (result.status === 'timedout') console.log(c.red('The run timed out.'));
  }

  printsToStdio() {
    return true;
  }
}
