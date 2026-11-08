// Runs the HumanTest server (port 4800) and the Vite dev server (port 5173) together,
// so UI changes in ui/src show up at once. Open http://localhost:5173.
// Ctrl+C stops both.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';

// If a HumanTest server is already up on 4800, use it instead of starting a second one.
const serverUp = await new Promise((resolve) => {
  const s = net.connect(4800, '127.0.0.1');
  s.once('connect', () => { s.end(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (serverUp) console.log('[server] already running on port 4800, using it');

const procs = [
  ...(serverUp ? [] : [{ name: 'server', cmd: 'node src/ui/server.mts' }]),
  { name: 'vite', cmd: 'npm run dev -w ui' },
].map(({ name, cmd }) => {
  const p = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
  const tag = `[${name}] `;
  const pipe = (from, to) => from.on('data', (d) => {
    to.write(d.toString().replace(/^(?=.)/gm, tag));
  });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${tag}exited (${code ?? 'signal'})`);
    stopAll();
  });
  return p;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

console.log('UI with hot reload: http://localhost:5173');
