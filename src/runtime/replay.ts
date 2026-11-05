// Builds the "replay" for a demo run: seekable mp4s, an optional side-by-side mp4,
// and replay.html, which plays every user's video in sync next to the list of steps.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ReplayStep {
  user: string;
  line: number;
  text: string;
  start: number; // ms since the replay's time zero
  end: number;
  status: 'passed' | 'failed';
  error?: string;
}
export interface ReplayRequest { user: string; method: string; path: string; status?: number; at: number; simulated?: boolean }
export interface ReplayVideo { user: string; file: string; offset: number }
export interface ReplayData {
  title: string;
  source: string;
  status: 'passed' | 'failed';
  videos: ReplayVideo[];
  steps: ReplayStep[];
  requests: ReplayRequest[];
  warnings: { user: string; line: number; message: string }[];
}

function ffmpegPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static') as string | null;
    return p && fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function ffmpeg(args: string[]): boolean {
  const bin = ffmpegPath();
  if (!bin) return false;
  const r = spawnSync(bin, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) console.warn(`ffmpeg failed: ${r.stderr?.toString().slice(0, 500)}`);
  return r.status === 0;
}

/** Length of a video in ms, read from ffmpeg's own report. */
export function videoDuration(file: string): number | undefined {
  const bin = ffmpegPath();
  if (!bin) return undefined;
  const r = spawnSync(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  const m = r.stderr?.toString().match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : undefined;
}

/** Playwright's webm has no seek index, so browsers can't jump around in it. An mp4 can. */
export function toMp4(webm: string, mp4: string): boolean {
  return ffmpeg(['-i', webm, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', '+faststart', mp4]);
}

/** One video with every user next to each other, each starting at the right moment. */
export function sideBySide(inputs: { file: string; offset: number }[], out: string): boolean {
  if (inputs.length < 2) return false;
  const filters = inputs.map((v, i) =>
    `[${i}:v]scale=960:540,setsar=1,tpad=start_duration=${(v.offset / 1000).toFixed(3)}:start_mode=add:color=0xf3f4f6[v${i}]`);
  const stack = `${inputs.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${inputs.length}[out]`;
  return ffmpeg([...inputs.flatMap((v) => ['-i', v.file]), '-filter_complex', [...filters, stack].join(';'),
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out]);
}

export function writeReplay(dir: string, data: ReplayData): string {
  const file = path.join(dir, 'replay.html');
  // Inline JSON is safe in a <script> once "<" is escaped.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  fs.writeFileSync(file, PAGE.replace('__TITLE__', escapeHtml(data.title)).replace('__DATA__', json));
  return file;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replay · __TITLE__</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #18202b; --muted: #667085; --line: #e3e6eb;
    --accent: #2563eb; --accent-soft: #e8efff; --ok: #15803d; --bad: #c62828; --bad-soft: #fdecec; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1218; --panel: #171b23; --text: #e6e9ef; --muted: #98a2b3; --line: #2a303b;
      --accent: #6b9bff; --accent-soft: #1d2a44; --ok: #4ade80; --bad: #f87171; --bad-soft: #3a1d1d; --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; }
  header .src { color: var(--muted); font-size: 12px; margin-left: auto; font-family: ui-monospace, monospace; }
  .badge { font-size: 12px; font-weight: 650; padding: 2px 10px; border-radius: 999px; }
  .badge.passed { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .badge.failed { background: var(--bad-soft); color: var(--bad); }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 16px; padding: 16px 20px 0; height: calc(100vh - 57px - 74px); }
  .videos { display: grid; gap: 12px; align-content: start; overflow: auto; }
  .videos.n2, .videos.n3, .videos.n4 { grid-template-columns: repeat(2, 1fr); }
  .card { background: var(--panel); border: 2px solid var(--line); border-radius: 12px; overflow: hidden; transition: opacity .2s, border-color .2s; }
  .card.active { border-color: var(--accent); }
  .card.idle { opacity: .55; }
  .card .who { display: flex; justify-content: space-between; padding: 8px 12px; font-weight: 600; font-size: 13px; }
  .card .who span:last-child { color: var(--muted); font-weight: 500; }
  .card video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  aside { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: auto; }
  aside h2 { font-size: 13px; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
  .step { display: grid; grid-template-columns: 34px 1fr; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .step:hover { background: var(--accent-soft); }
  .step.current { background: var(--accent-soft); box-shadow: inset 3px 0 var(--accent); }
  .step.failed { background: var(--bad-soft); box-shadow: inset 3px 0 var(--bad); }
  .group { padding: 10px 14px 4px; font-weight: 650; font-size: 13px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--accent-soft) 45%, var(--panel)); }
  .step.sub { padding-left: 26px; }
  .step .ln { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; padding-top: 1px; }
  .step .who { font-size: 11px; color: var(--muted); }
  .step .txt { word-break: break-word; }
  .step .story { color: var(--muted); font-size: 12px; }
  .step .req { font-family: ui-monospace, monospace; font-size: 11.5px; color: var(--muted); margin-top: 3px; }
  .step .req.bad { color: var(--bad); }
  .step .err { color: var(--bad); font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; margin-top: 4px; }
  .warn { padding: 8px 14px; color: var(--warn); font-size: 12.5px; border-bottom: 1px solid var(--line); }
  .banner { margin: 0 20px; margin-top: 12px; padding: 10px 14px; border-radius: 10px; background: var(--bad-soft); color: var(--bad); font-family: ui-monospace, monospace; font-size: 12.5px; white-space: pre-wrap; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; height: 74px; display: flex; align-items: center; gap: 12px; padding: 0 20px; background: var(--panel); border-top: 1px solid var(--line); }
  button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  #play { width: 44px; font-size: 16px; }
  .track { position: relative; flex: 1; height: 34px; }
  .track input { position: absolute; inset: 0; width: 100%; margin: 0; accent-color: var(--accent); }
  .tick { position: absolute; top: 2px; width: 2px; height: 8px; background: var(--muted); opacity: .6; pointer-events: none; }
  .tick.failed { background: var(--bad); opacity: 1; height: 12px; width: 3px; }
  #time { font-family: ui-monospace, monospace; color: var(--muted); min-width: 110px; text-align: right; }
  .note { color: var(--muted); padding: 40px; }
  @media (max-width: 900px) {
    main { grid-template-columns: 1fr; height: auto; padding-bottom: 90px; }
    .videos.n2, .videos.n3, .videos.n4 { grid-template-columns: 1fr; }
    aside { max-height: 50vh; }
  }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <span id="badge" class="badge"></span>
  <span class="src" id="src"></span>
</header>
<div id="banner" class="banner" hidden></div>
<main>
  <section class="videos" id="videos"></section>
  <aside><h2>Steps <span style="color:var(--muted);font-weight:400">· click one to jump there</span></h2><div id="warnings"></div><div id="steps"></div></aside>
</main>
<footer>
  <button id="play" title="Play / pause (space)">▶</button>
  <div class="track" id="track"><input id="seek" type="range" min="0" step="10" value="0" aria-label="Position"></div>
  <span id="time">0:00 / 0:00</span>
  <span id="speeds"></span>
</footer>
<script>
const D = __DATA__;
const $ = (id) => document.getElementById(id);
// Inside the HumanTest UI (?embed), the UI already shows the title and status.
if (new URLSearchParams(location.search).has('embed')) {
  // style.display, not .hidden: the header's own "display: flex" would win over the hidden attribute.
  document.querySelector('header').style.display = 'none';
  document.querySelector('main').style.height = 'calc(100vh - 74px)';
}
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

$('title').textContent = D.title;
$('badge').textContent = D.status === 'passed' ? 'passed' : 'failed';
$('badge').className = 'badge ' + D.status;
$('src').textContent = D.source;

// ---------- videos ----------
const vbox = $('videos');
vbox.className = 'videos n' + Math.min(D.videos.length, 4);
const players = D.videos.map((v) => {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<div class="who"><span></span><span></span></div>';
  card.querySelector('.who span').textContent = '👤 ' + v.user;
  const el = document.createElement('video');
  el.src = v.file; el.muted = true; el.preload = 'auto'; el.playsInline = true;
  card.appendChild(el);
  vbox.appendChild(card);
  return { ...v, el, card, status: card.querySelector('.who span:last-child') };
});
if (!players.length) vbox.innerHTML = '<p class="note">No video was recorded. Run the tests with --demo to record one.</p>';

// ---------- steps ----------
const stepsBox = $('steps');
let prevStory = null;
const stepEls = D.steps.map((s, i) => {
  const parts = s.text.split(' › ');
  // A story line ("Rahim signs up with …") is shown once, as a heading over the steps it stands for.
  const story = parts.length > 1 ? parts[0] + '|' + s.line : null;
  if (story && story !== prevStory) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = s.line + ' · ' + parts[0];
    stepsBox.appendChild(h);
  }
  prevStory = story;
  if (story) parts.shift();
  const el = document.createElement('div');
  el.className = 'step' + (story ? ' sub' : '') + (s.status === 'failed' ? ' failed' : '');
  const reqs = D.requests.filter((r) => r.user === s.user && r.at >= s.start - 50 && r.at <= s.end + 50);
  el.innerHTML = '<div class="ln"></div><div><div class="who"></div>' + (parts.length > 1 ? '<div class="story"></div>' : '') + '<div class="txt"></div></div>';
  el.querySelector('.ln').textContent = s.line;
  el.querySelector('.who').textContent = s.user;
  if (parts.length > 1) el.querySelector('.story').textContent = parts[0];
  el.querySelector('.txt').textContent = (s.status === 'failed' ? '✗ ' : '') + parts[parts.length - 1];
  const body = el.children[1];
  for (const r of reqs) {
    const d = document.createElement('div');
    d.className = 'req' + ((r.status ?? 0) >= 400 ? ' bad' : '');
    d.textContent = '→ ' + r.method + ' ' + r.path + '  ' + (r.status ?? '…') + (r.simulated ? ' (simulated)' : '');
    body.appendChild(d);
  }
  if (s.error) {
    const d = document.createElement('div');
    d.className = 'err';
    d.textContent = s.error;
    body.appendChild(d);
  }
  el.addEventListener('click', () => { seek(Math.max(0, s.start - 300)); });
  stepsBox.appendChild(el);
  return el;
});
for (const w of D.warnings) {
  const d = document.createElement('div');
  d.className = 'warn';
  d.textContent = '⚠ line ' + w.line + ' · ' + w.user + ' · ' + w.message;
  $('warnings').appendChild(d);
}

// ---------- one clock for every video ----------
let t = 0, playing = false, rate = 1, last = 0;
let total = Math.max(1000, ...D.steps.map((s) => s.end + 1000));
const seekEl = $('seek');

function durations() {
  for (const p of players) if (isFinite(p.el.duration)) total = Math.max(total, p.offset + p.el.duration * 1000);
  seekEl.max = String(Math.round(total));
  drawTicks();
}
players.forEach((p) => p.el.addEventListener('loadedmetadata', durations));

function drawTicks() {
  const track = $('track');
  track.querySelectorAll('.tick').forEach((e) => e.remove());
  D.steps.forEach((s) => {
    const k = document.createElement('div');
    k.className = 'tick' + (s.status === 'failed' ? ' failed' : '');
    k.style.left = (s.start / total * 100) + '%';
    track.appendChild(k);
  });
}

function sync(force) {
  // The current step is the latest one that has started (and isn't long over).
  let current = -1;
  for (let i = D.steps.length - 1; i >= 0; i--) {
    if (D.steps[i].start <= t) { if (t <= D.steps[i].end + 400) current = i; break; }
  }
  const activeUser = current >= 0 ? D.steps[current].user : null;
  for (const p of players) {
    const local = (t - p.offset) / 1000;
    const dur = isFinite(p.el.duration) ? p.el.duration : Infinity;
    p.el.playbackRate = rate;
    if (local < 0) {
      if (!p.el.paused) p.el.pause();
      if (p.el.currentTime !== 0) p.el.currentTime = 0;
      p.status.textContent = 'not started yet';
    } else if (local >= dur) {
      if (!p.el.paused) p.el.pause();
      p.status.textContent = 'finished';
    } else {
      if (force || Math.abs(p.el.currentTime - local) > 0.3) p.el.currentTime = local;
      if (playing && p.el.paused) p.el.play().catch(() => {});
      if (!playing && !p.el.paused) p.el.pause();
      p.status.textContent = fmt(local * 1000);
    }
    p.card.classList.toggle('active', p.user === activeUser);
    p.card.classList.toggle('idle', activeUser !== null && p.user !== activeUser && players.length > 1);
  }
  stepEls.forEach((el, i) => el.classList.toggle('current', i === current));
  if (current >= 0 && playing) stepEls[current].scrollIntoView({ block: 'nearest' });
  seekEl.value = String(Math.round(t));
  $('time').textContent = fmt(t) + ' / ' + fmt(total);
}

function frame(now) {
  if (playing) {
    t += (now - last) * rate;
    if (t >= total) { t = total; setPlaying(false); }
    sync(false);
  }
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame((now) => { last = now; frame(now); });

function setPlaying(on) {
  playing = on;
  $('play').textContent = on ? '❚❚' : '▶';
  if (on && t >= total) t = 0;
  sync(true);
}
function seek(ms) { t = Math.min(Math.max(0, ms), total); sync(true); }

$('play').addEventListener('click', () => setPlaying(!playing));
seekEl.addEventListener('input', () => seek(Number(seekEl.value)));
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  const idx = D.steps.findIndex((s) => s.start > t + 50);
  if (e.key === 'ArrowDown' && idx >= 0) seek(D.steps[idx].start - 300);
  if (e.key === 'ArrowUp') {
    const prev = [...D.steps].reverse().find((s) => s.start < t - 400);
    seek(prev ? prev.start - 300 : 0);
  }
});

const speeds = $('speeds');
[0.5, 1, 1.5, 2].forEach((r) => {
  const b = document.createElement('button');
  b.textContent = r + 'x';
  if (r === 1) b.classList.add('on');
  b.addEventListener('click', () => {
    rate = r;
    speeds.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    sync(true);
  });
  speeds.appendChild(b);
});

// A failed run opens a moment before the failing step.
const failed = D.steps.find((s) => s.status === 'failed');
if (failed) {
  $('banner').hidden = false;
  const why = (failed.error || '').split('\\n').map((l) => l.trim()).filter((l) => l && l !== 'What went wrong:')[0];
  $('banner').textContent = '✗ Failed at line ' + failed.line + ' (' + failed.user + '): ' + failed.text.split(' › ').pop() + (why ? '\\n   ' + why : '');
  setTimeout(() => { seek(Math.max(0, failed.start - 1500)); stepEls[D.steps.indexOf(failed)].scrollIntoView({ block: 'center' }); }, 300);
}
durations();
sync(true);
</script>
</body>
</html>
`;
