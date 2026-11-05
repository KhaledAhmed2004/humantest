// Builds the "replay" for a demo run: seekable mp4s, an optional side-by-side mp4,
// and replay.html, which plays every user's video in sync next to the list of steps.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { humanize } from '../humanize';

export interface ReplayStep {
  user: string;
  line: number;
  text: string;
  start: number; // ms since the replay's time zero
  end: number;
  status: 'passed' | 'failed';
  error?: string;
  /** The element the step acted on or checked, in page pixels (1280×720), for zooming in. */
  box?: { x: number; y: number; w: number; h: number };
}
export interface ReplayRequest { user: string; method: string; path: string; status?: number; at: number; simulated?: boolean }
/** burnedCaptions: the video already has captions painted in (Playwright's own video), so the page adds none. */
export interface ReplayVideo { user: string; file: string; offset: number; burnedCaptions?: boolean }
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

export const hasFfmpeg = () => !!ffmpegPath();

function ffmpeg(args: string[], cwd?: string): boolean {
  const bin = ffmpegPath();
  if (!bin) return false;
  const r = spawnSync(bin, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'], cwd });
  if (r.status !== 0) console.warn(`ffmpeg failed: ${r.stderr?.toString().slice(0, 500)}`);
  return r.status === 0;
}

/** Playwright's webm has no seek index, so browsers can't jump around in it. An mp4 can. */
export function toMp4(webm: string, mp4: string): boolean {
  return ffmpeg(['-i', webm, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', '+faststart', mp4]);
}

export interface Frame { file: string; ts: number }

/**
 * Turns screencast frames (JPEGs, each with the exact time it was painted) into an mp4.
 * The browser only sends a frame when something changes, so each frame is held until the next one.
 */
export function encodeFrames(frames: Frame[], endTs: number, out: string, size = { width: 1280, height: 720 }): boolean {
  if (!frames.length) return false;
  const q = (f: string) => `'${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const lines = frames.map((f, i) => {
    const next = frames[i + 1]?.ts ?? endTs;
    return `file ${q(f.file)}\nduration ${Math.max(0.001, (next - f.ts) / 1000).toFixed(3)}`;
  });
  // The concat format ignores the last duration unless the last file is listed once more.
  lines.push(`file ${q(frames[frames.length - 1].file)}`);
  const list = `${out}.frames.txt`;
  fs.writeFileSync(list, lines.join('\n'));
  const ok = ffmpeg(['-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '30', '-movflags', '+faststart', '-an', out]);
  fs.rmSync(list, { force: true });
  return ok;
}

/** A font ffmpeg can draw captions with, or undefined (then the side-by-side video has no captions). */
function captionFont(): string | undefined {
  return [
    'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  ].find((f) => fs.existsSync(f));
}

export interface Caption { start: number; end: number; text: string }

/**
 * One video with every user next to each other, each starting at the right moment,
 * with each user's current step written under their side (the replay page shows captions itself).
 */
export function sideBySide(inputs: { file: string; offset: number; captions?: Caption[] }[], out: string): boolean {
  if (inputs.length < 2) return false;
  const font = captionFont();
  // Caption texts go in small files next to the output, so no step text needs ffmpeg escaping.
  const capDir = `${out}.captions`;
  fs.mkdirSync(capDir, { recursive: true });
  let n = 0;
  const filters = inputs.map((v, i) => {
    let chain = `[${i}:v]scale=960:540,setsar=1,tpad=start_duration=${(v.offset / 1000).toFixed(3)}:start_mode=add:color=0xf3f4f6`;
    if (font) {
      for (const c of v.captions ?? []) {
        const name = `c${n++}.txt`;
        fs.writeFileSync(path.join(capDir, name), c.text);
        chain += `,drawtext=fontfile='${font.replace(':', '\\:')}':textfile='${name}':fontsize=20:fontcolor=white` +
          `:box=1:boxcolor=0x111827@0.88:boxborderw=10:x=(w-tw)/2:y=h-th-22` +
          `:enable='between(t,${(c.start / 1000).toFixed(2)},${(c.end / 1000).toFixed(2)})'`;
      }
    }
    return `${chain}[v${i}]`;
  });
  const stack = `${inputs.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${inputs.length}[out]`;
  const graph = path.join(capDir, 'graph.txt');
  fs.writeFileSync(graph, [...filters, stack].join(';\n'));
  // ffmpeg runs inside the captions folder, so textfile='c0.txt' resolves there.
  const ok = ffmpeg([...inputs.flatMap((v) => ['-i', path.resolve(v.file)]), '-filter_complex_script', 'graph.txt',
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', path.resolve(out)], capDir);
  fs.rmSync(capDir, { recursive: true, force: true });
  return ok;
}

export function writeReplay(dir: string, data: ReplayData): string {
  const file = path.join(dir, 'replay.html');
  // Inline JSON is safe in a <script> once "<" is escaped.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  // Function replacers: a plain string would treat "$&" or "$'" inside the data or code as patterns.
  fs.writeFileSync(file, PAGE
    .replace('__TITLE__', () => escapeHtml(data.title))
    .replace('__HUMANIZE__', () => humanize.toString())
    .replace('__DATA__', () => json));
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
    color-scheme: light;
    --bg: #f6f7f9; --panel: #ffffff; --text: #18202b; --muted: #667085; --line: #e3e6eb;
    --accent: #2563eb; --accent-soft: #e8efff; --ok: #15803d; --bad: #c62828; --bad-soft: #fdecec; --warn: #b45309;
    --thumb: #d4d8de; --thumb-hover: #b3b9c2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0f1218; --panel: #171b23; --text: #e6e9ef; --muted: #98a2b3; --line: #2a303b;
      --accent: #6b9bff; --accent-soft: #1d2a44; --ok: #4ade80; --bad: #f87171; --bad-soft: #3a1d1d; --warn: #fbbf24;
      --thumb: #343b47; --thumb-hover: #4a5361;
    }
  }
  * { box-sizing: border-box; }
  /* Scrollbars styled like shadcn/ui's ScrollArea: 10px wide, no track, a round thumb in the border colour.
     (This page is plain HTML, so it copies the look instead of using the React component.) */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--thumb); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background-color: var(--thumb-hover); }
  ::-webkit-scrollbar-button { display: none; height: 0; width: 0; }
  @supports (-moz-appearance: none) { * { scrollbar-width: thin; scrollbar-color: var(--thumb) transparent; } }
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
  main.single { grid-template-columns: 1fr 340px; }
  /* One video: as big as fits the window's height too, so its caption strip is never cut off. */
  .videos.n1 .card { width: min(100%, calc((100vh - 290px) * 16 / 9)); justify-self: center; }
  body.embed .videos.n1 .card { width: min(100%, calc((100vh - 230px) * 16 / 9)); }
  body.wide main { grid-template-columns: 1fr; }
  body.wide aside { display: none; }
  /* Captions are drawn here, not painted into the video, so they stay sharp at any size.
     They sit in a strip under the video rather than on top of it, so they never cover what's happening. */
  /* Smart zoom: the video moves and scales inside this frame; the frame clips it. */
  .frame { position: relative; overflow: hidden; background: #000; }
  .frame video { transform-origin: 0 0; transition: transform .75s cubic-bezier(.4, 0, .2, 1); will-change: transform; }
  body.nozoom .frame video { transform: none !important; }
  .cap { display: flex; align-items: center; justify-content: center; gap: .6em; min-height: 2.6em; padding: .35em 1em;
    background: #111827; color: #fff; font: 600 clamp(12px, 1.25vw, 17px)/1.35 system-ui, sans-serif; text-align: center; }
  .cap .ln { opacity: .6; font-weight: 500; white-space: nowrap; }
  .cap:empty::before { content: '\\00a0'; }
  body.nocap .cap { display: none; }
  :fullscreen main { height: calc(100vh - 74px); }
  .tip { position: absolute; bottom: calc(100% + 4px); transform: translateX(-50%); background: #111827; color: #fff; font-size: 12px;
    padding: 4px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
  .tip[hidden] { display: none; }
  aside { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: auto; }
  .aside-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px 16px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; background: var(--panel); }
  .aside-head h2 { font-size: 14px; margin: 0; font-weight: 650; }
  .aside-head .count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .tl, .subs { list-style: none; margin: 0; padding: 0; }
  .tl { padding: 10px 0 16px; }
  /* A row: [status] [title + status line] [time]. Rounded, so the highlight floats. */
  .row { position: relative; display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; align-items: start;
    margin: 0 8px; padding: 8px 10px 8px 6px; border-radius: 12px; cursor: pointer; transition: background .15s; }
  .row:hover { background: color-mix(in srgb, var(--muted) 9%, transparent); }
  .row.current { background: color-mix(in srgb, var(--accent) 9%, transparent); }

  /* The rail joins the status icons. It turns green up to the last finished part. */
  .row::before { content: ''; position: absolute; left: 17px; top: 0; bottom: 0; width: 2px; background: var(--line); }
  .row.done::before { background: color-mix(in srgb, var(--ok) 70%, var(--line)); }
  .row.current::before { background: linear-gradient(color-mix(in srgb, var(--ok) 70%, var(--line)) 18px, var(--line) 18px); }
  .tl > li:first-child > .row::before { top: 18px; }
  .tl > li:last-child:not(.open) > .row::before,
  .tl > li:last-child .subs > li:last-child > .row::before { bottom: calc(100% - 18px); }

  /* Status icon: grey ring = later · green ✓ = completed · blue ring filling up = in progress · red ✕ = failed */
  .st { position: relative; z-index: 1; width: 24px; height: 24px; border-radius: 50%; background: var(--panel); }
  .st svg { width: 24px; height: 24px; display: block; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .st .trk { stroke: color-mix(in srgb, var(--muted) 45%, var(--panel)); }
  .st .arc { stroke: var(--accent); stroke-width: 2.6; display: none; transition: stroke-dasharray .4s ease; }
  .st .ok, .st .no { display: none; }
  .row.done .st .trk { stroke: var(--ok); }
  .row.done .st .ok { display: block; stroke: var(--ok); }
  .row.current .st .trk { stroke: color-mix(in srgb, var(--accent) 22%, var(--panel)); }
  .row.current .st .arc { display: block; }
  .row.failed .st .trk { stroke: var(--bad); }
  .row.failed .st .arc, .row.failed .st .ok { display: none; }
  .row.failed .st .no { display: block; stroke: var(--bad); }

  .title { font-size: 14px; font-weight: 600; line-height: 1.4; word-break: break-word; }
  .row:not(.done):not(.current):not(.failed) .title { color: color-mix(in srgb, var(--text) 78%, var(--panel)); }
  .meta { display: block; font-size: 12.5px; line-height: 1.45; color: var(--muted); margin-top: 1px; }
  .stx { font-weight: 600; }
  .row.done .stx { color: var(--ok); }
  .row.current .stx { color: var(--accent); }
  .row.failed .stx { color: var(--bad); }
  .time { font: 11.5px/1 ui-monospace, monospace; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 5px; }
  .who { display: inline-block; font-size: 11px; font-weight: 650; padding: 0 6px; margin-right: 6px; border-radius: 6px;
    background: var(--accent-soft); color: var(--accent); vertical-align: 1px; }

  /* Steps inside a part: small marks on the same rail — ✓ done, blue dot now, hollow later. */
  .subs { display: none; padding-bottom: 4px; }
  .g.open .subs { display: block; }
  .subs .row { padding-top: 5px; padding-bottom: 5px; }
  .subs .row.current { background: none; }
  .sm { position: relative; z-index: 1; width: 24px; height: 20px; display: grid; place-items: center; }
  .sm::after { content: ''; width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box;
    border: 1.5px solid color-mix(in srgb, var(--muted) 55%, var(--panel)); background: var(--panel); }
  .row.done .sm::after { content: '✓'; width: auto; height: auto; border: 0; border-radius: 0; background: var(--panel);
    color: var(--ok); font: 700 12px/1 system-ui, sans-serif; padding: 1px 0; }
  .row.current .sm::after { width: 10px; height: 10px; border: 0; background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .row.failed .sm::after { content: '×'; width: auto; height: auto; border: 0; border-radius: 0; background: var(--panel);
    color: var(--bad); font: 700 14px/1 system-ui, sans-serif; }
  .step-text { font-size: 13px; line-height: 1.45; word-break: break-word; color: color-mix(in srgb, var(--text) 82%, var(--panel)); }
  .row.done .step-text { color: var(--muted); }
  .row.current .step-text { color: var(--accent); font-weight: 600; }
  .row.failed .step-text { color: var(--bad); font-weight: 600; }
  .subs .meta { font-size: 12px; }
  .subs .time { padding-top: 3px; }

  .chev { border: 0; background: none; padding: 3px; margin: 1px 0 0; color: var(--muted); cursor: pointer; border-radius: 6px;
    display: inline-grid; place-items: center; transition: transform .2s, background .15s; }
  .chev:hover { background: color-mix(in srgb, var(--muted) 16%, transparent); color: var(--text); }
  .chev svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .g.open .chev { transform: rotate(90deg); }
  .row.gh { grid-template-columns: 24px 1fr auto auto; }

  .req { font: 11.5px/1.5 ui-monospace, monospace; color: var(--muted); margin-top: 2px; }
  .req.bad { color: var(--bad); }
  .err { margin-top: 6px; font-size: 12.5px; line-height: 1.45; color: var(--bad); background: var(--bad-soft); border-radius: 8px;
    padding: 6px 9px; white-space: pre-wrap; }
  .warn { margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.45;
    background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
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
  <aside aria-label="Steps"><div class="aside-head"><h2>Steps</h2><span class="count" id="count"></span></div><div id="warnings"></div><ol class="tl" id="steps"></ol></aside>
</main>
<footer>
  <button id="play" title="Play / pause (space)">▶</button>
  <div class="track" id="track"><input id="seek" type="range" min="0" step="10" value="0" aria-label="Position"><div class="tip" id="tip" hidden></div></div>
  <span id="time">0:00 / 0:00</span>
  <span id="speeds"></span>
  <button id="zoom" title="Zoom in on each action (z)" aria-pressed="true">🔍 Zoom</button>
  <button id="cc" title="Captions (c)" aria-pressed="true">CC</button>
  <button id="side" title="Show or hide the steps (s)" aria-pressed="true">☰ Steps</button>
  <button id="full" title="Fullscreen (f)" aria-label="Fullscreen">⛶</button>
</footer>
<script>
const D = __DATA__;
const $ = (id) => document.getElementById(id);
// Inside the HumanTest UI (?embed), the UI already shows the title and status.
if (new URLSearchParams(location.search).has('embed')) {
  // style.display, not .hidden: the header's own "display: flex" would win over the hidden attribute.
  document.querySelector('header').style.display = 'none';
  document.querySelector('main').style.height = 'calc(100vh - 74px)';
  document.body.classList.add('embed');
}
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

$('title').textContent = D.title;
$('badge').textContent = D.status === 'passed' ? 'passed' : 'failed';
$('badge').className = 'badge ' + D.status;
$('src').textContent = D.source;

// ---------- videos ----------
const vbox = $('videos');
vbox.className = 'videos n' + Math.min(D.videos.length, 4);
if (D.videos.length <= 1) document.querySelector('main').classList.add('single');
const players = D.videos.map((v) => {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<div class="who"><span></span><span></span></div><div class="frame"></div>';
  card.querySelector('.who span').textContent = '👤 ' + v.user;
  const el = document.createElement('video');
  el.src = v.file; el.muted = true; el.preload = 'auto'; el.playsInline = true;
  const cap = document.createElement('div');
  cap.className = 'cap';
  card.querySelector('.frame').append(el);
  card.append(cap);
  vbox.appendChild(card);
  return { ...v, el, card, cap, status: card.querySelector('.who span:last-child') };
});
if (!players.length) vbox.innerHTML = '<p class="note">No video was recorded. Run the tests with --demo to record one.</p>';

// ---------- steps, in plain words ----------
const humanize = __HUMANIZE__;
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const ownText = (s) => s.text.split(' › ').pop();
const say = (s) => humanize(ownText(s));
// Only name the user when there is more than one.
const multiUser = new Set(D.steps.map((s) => s.user).filter((u) => u !== 'setup')).size > 1;
const cleanError = (e) => e.split('\\n').map((l) => l.trim())
  .filter((l) => l && l !== 'What went wrong:' && !/^(Line \\d+ ·|📄)/.test(l)).join('\\n');

// The status icon of a part: a track ring, a progress arc, a check and a cross; CSS shows the right ones.
const STATUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle class="trk" cx="12" cy="12" r="10"/>' +
  '<circle class="arc" cx="12" cy="12" r="10" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 12 12)"/>' +
  '<path class="ok" d="m8 12.4 2.8 2.8 5.4-5.6"/><path class="no" d="M9 9l6 6M15 9l-6 6"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function details(body, s) {
  for (const r of D.requests.filter((r) => r.user === s.user && r.at >= s.start - 50 && r.at <= s.end + 50)) {
    body.append(el('div', 'req' + ((r.status ?? 0) >= 400 ? ' bad' : ''), r.method + ' ' + r.path + ' → ' + (r.status ?? '…') + (r.simulated ? ' (simulated)' : '')));
  }
  if (s.error) body.append(el('div', 'err', cleanError(s.error)));
}
function titleWithUser(text, user) {
  const t = el('div', 'title');
  if (multiUser && user !== 'setup') t.append(el('span', 'who', user));
  t.append(document.createTextNode(text));
  return t;
}

// A top-level row: one step, or a story line that has a single step (story on top, the step in the status line).
function makeTopRow(s, storyTitle) {
  const li = el('li');
  const row = el('div', 'row' + (s.status === 'failed' ? ' failed' : ''));
  row.title = 'Line ' + s.line + ' of the test: ' + ownText(s);
  const h = say(s);
  const st = el('span', 'st');
  st.innerHTML = STATUS_SVG;
  const body = el('div');
  body.append(titleWithUser(storyTitle ? cap(storyTitle) : h.text, s.user));
  const meta = el('span', 'meta');
  const stx = el('span', 'stx');
  const rest = storyTitle ? h.text + (h.where ? ' · in ' + h.where : '') : (h.where ? 'in ' + h.where : '');
  meta.append(stx, el('span', 'rest', rest));
  body.append(meta);
  details(body, s);
  row.append(st, body, el('span', 'time', fmt(s.start)));
  row.addEventListener('click', (e) => { e.stopPropagation(); seek(s.start + 1); });
  li.append(row);
  return { li, row, stx, arc: st.querySelector('.arc'), rest: meta.querySelector('.rest'), restText: rest };
}

// A step inside an open part: a small mark, the step in plain words, its time.
function makeSubRow(s) {
  const li = el('li');
  const row = el('div', 'row' + (s.status === 'failed' ? ' failed' : ''));
  row.title = 'Line ' + s.line + ' of the test: ' + ownText(s);
  const h = say(s);
  const body = el('div');
  body.append(el('div', 'step-text', h.text));
  if (h.where) body.append(el('span', 'meta', 'in ' + h.where));
  details(body, s);
  row.append(el('span', 'sm'), body, el('span', 'time', fmt(s.start)));
  row.addEventListener('click', (e) => { e.stopPropagation(); seek(s.start + 1); });
  li.append(row);
  return { li, row };
}

const stepsBox = $('steps');
const stepEls = new Array(D.steps.length);
const tops = [];     // top-level single rows: { i, row, stx, arc, rest }
const groups = [];   // story parts with several steps
const storyKey = (x) => (x.text.includes(' › ') ? x.text.split(' › ')[0] + '|' + x.line : null);
for (let i = 0; i < D.steps.length; i++) {
  const s = D.steps[i];
  const key = storyKey(s);
  const idx = [i];
  if (key) { while (i + 1 < D.steps.length && storyKey(D.steps[i + 1]) === key) idx.push(++i); }
  if (idx.length === 1) {
    const r = makeTopRow(s, key ? s.text.split(' › ')[0] : null);
    stepsBox.append(r.li);
    stepEls[idx[0]] = r.row;
    tops.push({ i: idx[0], ...r });
    continue;
  }
  const first = D.steps[idx[0]];
  const li = el('li', 'g');
  const head = el('div', 'row gh' + (idx.some((j) => D.steps[j].status === 'failed') ? ' failed' : ''));
  head.title = 'Line ' + first.line + ' of the test';
  const st = el('span', 'st');
  st.innerHTML = STATUS_SVG;
  const body = el('div');
  body.append(titleWithUser(cap(first.text.split(' › ')[0]), first.user));
  const meta = el('span', 'meta');
  const stx = el('span', 'stx');
  meta.append(stx);
  body.append(meta);
  const chev = el('button', 'chev');
  chev.type = 'button';
  chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  chev.setAttribute('aria-label', 'Show or hide the steps of this part');
  head.append(st, body, chev, el('span', 'time', fmt(first.start)));
  const subs = el('ol', 'subs');
  for (const j of idx) { const r = makeSubRow(D.steps[j]); subs.append(r.li); stepEls[j] = r.row; }
  li.append(head, subs);
  stepsBox.append(li);
  const g = { li, head, idx, stx, arc: st.querySelector('.arc'), manual: null, failed: idx.some((j) => D.steps[j].status === 'failed') };
  groups.push(g);
  head.addEventListener('click', () => { g.manual = null; seek(first.start + 1); });
  chev.addEventListener('click', (e) => { e.stopPropagation(); g.manual = !li.classList.contains('open'); sync(false); });
}
for (const w of D.warnings) {
  $('warnings').appendChild(el('div', 'warn', '⚠ Hidden problem: ' + w.message + (multiUser ? ' (' + w.user + ')' : '')));
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

// ---------- smart zoom ----------
// While a user acts on (or checks) an element, their video zooms toward it; between actions,
// and when a step has no element (a page load, a backend check), it zooms back out.
const VW = 1280, VH = 720;
function zoomTarget(user) {
  const mine = D.steps.filter((s) => s.user === user);
  let latest = -1;
  for (let i = 0; i < mine.length; i++) if (mine[i].start - 350 <= t) latest = i;
  const cur = mine[latest];
  if (cur && cur.box && t <= cur.end + 900) return { box: cur.box, ahead: lookAhead(mine, latest) };
  // Zoom in a moment early when the next step is about to act on something.
  const next = mine[latest + 1];
  if (next && next.box && next.start - t <= 350 && (!cur || cur.box || t > cur.end)) return { box: next.box, ahead: lookAhead(mine, latest + 1) };
  return null;
}
/** The boxes of this user's next few steps (within 2.5 s, until a step without one, like a page load). */
function lookAhead(mine, i) {
  const out = [];
  for (let j = i + 1; j < mine.length && mine[j].start - mine[i].start <= 2500; j++) {
    if (!mine[j].box) break;
    out.push(mine[j].box);
  }
  return out;
}
const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
/** The target box grown to include the coming boxes, as long as the result can still be zoomed into. */
function frameFor(target) {
  let box = target.box;
  for (const next of target.ahead) {
    const u = union(box, next);
    if (u.w / VW > 0.62 || u.h / VH > 0.62) break;   // would need too little zoom to be worth it
    box = u;
  }
  return box;
}
/** The camera (zoom z, offset tx/ty) that frames this box, or null for "show the whole page". */
function cameraFor(box) {
  if (!box) return null;
  const bw = box.w / VW, bh = box.h / VH;
  if (bw > 0.7 || bh > 0.75) return null;              // big targets (a whole dialog) need no zoom
  const z = Math.max(1.35, Math.min(0.55 / bw, 0.6 / bh, 2));
  const cx = (box.x + box.w / 2) / VW, cy = (box.y + box.h / 2) / VH;
  const clamp = (v) => Math.min(Math.max(v, 0), z - 1);   // never show past the edge of the video
  return { z, tx: clamp(cx * z - 0.5), ty: clamp(cy * z - 0.5) };
}
/** True if the box is comfortably inside what this camera shows. */
function inView(cam, box) {
  const m = 0.04;   // keep a small margin from the edges
  const x0 = cam.tx / cam.z + m, x1 = (cam.tx + 1) / cam.z - m, y0 = cam.ty / cam.z + m, y1 = (cam.ty + 1) / cam.z - m;
  return box.x / VW >= x0 && (box.x + box.w) / VW <= x1 && box.y / VH >= y0 && (box.y + box.h) / VH <= y1;
}
const cssOf = (cam) => cam
  ? 'translate(' + (-cam.tx * 100).toFixed(2) + '%, ' + (-cam.ty * 100).toFixed(2) + '%) scale(' + cam.z.toFixed(3) + ')'
  : 'none';
/** Like a camera operator: only move when the next target is out of shot (less motion, easier to watch). */
function cameraUpdate(p, target) {
  if (!target) { p.cam = null; return cssOf(null); }
  if (p.cam && inView(p.cam, target.box)) return cssOf(p.cam);
  // Moving anyway: frame this step together with the next ones, so the camera can stay put for them.
  p.cam = cameraFor(frameFor(target));
  return cssOf(p.cam);
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
    // This user's step at this moment, as a caption over their video.
    let mine = null;
    if (!p.burnedCaptions) {
      for (let i = D.steps.length - 1; i >= 0; i--) {
        const s = D.steps[i];
        if (s.user !== p.user || s.start > t) continue;
        if (t <= s.end + 400) mine = s;
        break;
      }
    }
    const capText = mine ? mine.line + '|' + mine.text : '';
    if (p.cap.dataset.text !== capText) {
      p.cap.dataset.text = capText;
      p.cap.textContent = '';
      if (mine) {
        const ln = document.createElement('span');
        ln.className = 'ln';
        const h = say(mine);
        ln.textContent = h.where ? 'in ' + h.where : '';
        p.cap.append(document.createTextNode((mine.status === 'failed' ? '✗ ' : '') + h.text), ln);
      }
    }
    const zt = cameraUpdate(p, zoomTarget(p.user));
    if (p.el.dataset.zoom !== zt) { p.el.dataset.zoom = zt; p.el.style.transform = zt === 'none' ? '' : zt; }
    p.card.classList.toggle('active', p.user === activeUser);
    p.card.classList.toggle('idle', activeUser !== null && p.user !== activeUser && players.length > 1);
  }
  const isDone = (i) => i !== current && D.steps[i].start <= t;
  stepEls.forEach((row, i) => {
    row.classList.toggle('current', i === current);
    row.classList.toggle('done', isDone(i));
  });
  // Status line under each title, and how full the progress ring is.
  const word = (failed, done, now, n, total) =>
    failed && (done || now) ? 'Failed' : done ? 'Completed' : now ? (total > 1 ? 'In progress · ' + n + ' of ' + total : 'In progress') : '';
  for (const r of tops) {
    const s = D.steps[r.i];
    const txt = word(s.status === 'failed', isDone(r.i), r.i === current, 0, 1);
    if (r.stx.textContent !== txt) {
      r.stx.textContent = txt;
      r.rest.textContent = (txt && r.restText ? ' · ' : '') + r.restText;
    }
    r.arc.setAttribute('stroke-dasharray', '35 100');
  }
  for (const g of groups) {
    const has = g.idx.includes(current);
    const finished = g.idx.filter(isDone).length;
    const allDone = finished === g.idx.length;
    g.head.classList.toggle('current', has);
    g.head.classList.toggle('done', !has && allDone);
    const txt = word(g.failed, allDone, has, finished + (has ? 1 : 0), g.idx.length) || g.idx.length + ' steps';
    if (g.stx.textContent !== txt) g.stx.textContent = txt;
    g.arc.setAttribute('stroke-dasharray', Math.max(8, Math.round(((finished + (has ? 0.5 : 0)) / g.idx.length) * 100)) + ' 100');
    g.li.classList.toggle('open', g.manual ?? (has || g.failed));
  }
  $('count').textContent = D.steps.filter((x) => x.start <= t).length + ' of ' + D.steps.length;
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
// ---------- view options (remembered per browser) ----------
const pref = { get: (k) => { try { return localStorage.getItem('ht.replay.' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('ht.replay.' + k, v); } catch {} } };
function setCaptions(on) {
  document.body.classList.toggle('nocap', !on);
  $('cc').classList.toggle('on', on);
  $('cc').setAttribute('aria-pressed', String(on));
  pref.set('cc', on ? '1' : '0');
}
function setSteps(on) {
  document.body.classList.toggle('wide', !on);
  $('side').classList.toggle('on', on);
  $('side').setAttribute('aria-pressed', String(on));
  pref.set('steps', on ? '1' : '0');
}
function setZoom(on) {
  document.body.classList.toggle('nozoom', !on);
  $('zoom').classList.toggle('on', on);
  $('zoom').setAttribute('aria-pressed', String(on));
  pref.set('zoom', on ? '1' : '0');
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
// Captions only matter for videos that don't have them painted in.
if (players.every((p) => p.burnedCaptions)) $('cc').hidden = true;
setCaptions(pref.get('cc') !== '0');
setZoom(pref.get('zoom') !== '0');
if (!D.steps.some((s) => s.box)) $('zoom').hidden = true;
$('zoom').addEventListener('click', () => setZoom(document.body.classList.contains('nozoom')));
setSteps(pref.get('steps') !== '0');
$('cc').addEventListener('click', () => setCaptions(document.body.classList.contains('nocap')));
$('side').addEventListener('click', () => setSteps(document.body.classList.contains('wide')));
$('full').addEventListener('click', toggleFullscreen);

// ---------- hovering the timeline names the step at that moment ----------
const track = $('track'), tip = $('tip');
track.addEventListener('mousemove', (e) => {
  const box = track.getBoundingClientRect();
  const at = ((e.clientX - box.left) / box.width) * total;
  const s = [...D.steps].reverse().find((x) => x.start <= at);
  if (!s) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.textContent = fmt(at) + ' · ' + (multiUser ? s.user + ': ' : '') + say(s).text;
  tip.style.left = Math.min(Math.max(e.clientX - box.left, 120), box.width - 120) + 'px';
});
track.addEventListener('mouseleave', () => { tip.hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  const idx = D.steps.findIndex((s) => s.start > t + 50);
  if (e.key === 'ArrowDown' && idx >= 0) { e.preventDefault(); seek(D.steps[idx].start + 1); }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = [...D.steps].reverse().find((s) => s.start < t - 50);
    seek(prev ? prev.start + 1 : 0);
  }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - 5000); }
  if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + 5000); }
  if (e.key === 'f') toggleFullscreen();
  if (e.key === 'c' && !$('cc').hidden) setCaptions(document.body.classList.contains('nocap'));
  if (e.key === 's') setSteps(document.body.classList.contains('wide'));
  if (e.key === 'z' && !$('zoom').hidden) setZoom(document.body.classList.contains('nozoom'));
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
  $('banner').textContent = '✗ Failed: ' + say(failed).text + (multiUser ? ' (' + failed.user + ')' : '') + (why ? '\\n   ' + why : '');
  setTimeout(() => { seek(Math.max(0, failed.start - 1500)); stepEls[D.steps.indexOf(failed)].scrollIntoView({ block: 'center' }); }, 300);
}
durations();
sync(true);
</script>
</body>
</html>
`;
