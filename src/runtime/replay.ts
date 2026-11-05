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
  .tl { padding: 8px 0 16px; }
  /* A row: [status mark on the rail] [action icon] [words] [time]. Rows are rounded so the highlight floats. */
  .row { position: relative; display: grid; grid-template-columns: 16px 18px 1fr auto; gap: 8px; align-items: start;
    margin: 1px 8px; padding: 7px 10px 7px 6px; border-radius: 10px; cursor: pointer; transition: background .15s; }
  .row:hover { background: color-mix(in srgb, var(--accent-soft) 60%, transparent); }
  .row.current { background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
  .row.failed.current, .row.failed:hover { background: var(--bad-soft); }

  /* The rail: a line through every status mark, filled in up to where the video is. */
  .row::before { content: ''; position: absolute; left: 13px; top: -2px; bottom: -2px; width: 2px; border-radius: 2px;
    background: var(--line); z-index: 0; }
  .row.done::before { background: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  .row.current::before { background: linear-gradient(var(--accent) 50%, var(--line) 50%); }
  .tl > li:first-child > .row::before { top: 16px; }
  .tl > li:last-child:not(.open) > .row::before, .tl > li:last-child .subs > li:last-child > .row::before { bottom: calc(100% - 16px); }

  /* Status marks: hollow = still to come, ✓ = done, glowing = now, ✕ = failed. */
  .mark { position: relative; z-index: 1; width: 14px; height: 14px; margin-top: 3px; border-radius: 50%;
    background: var(--panel); border: 2px solid color-mix(in srgb, var(--muted) 50%, var(--panel)); display: grid; place-items: center; }
  .mark::after { content: ''; }
  .row.done .mark { background: color-mix(in srgb, var(--accent) 80%, var(--panel)); border-color: transparent; }
  .row.done .mark::after { width: 3px; height: 6px; margin-top: -2px; border: solid #fff; border-width: 0 1.6px 1.6px 0; transform: rotate(45deg); }
  .row.current .mark { background: var(--accent); border-color: var(--accent); animation: glow 1.6s ease-in-out infinite; }
  .row.current .mark::after { width: 4px; height: 4px; border-radius: 50%; background: #fff; }
  .row.failed .mark { background: var(--bad); border-color: var(--bad); animation: none; }
  .row.failed .mark::after { content: '×'; width: auto; height: auto; border: 0; transform: none; margin: -1px 0 0;
    color: #fff; font: 700 12px/1 system-ui, sans-serif; background: none; }
  @keyframes glow { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
                    50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 0%, transparent); } }
  @media (prefers-reduced-motion: reduce) { .row.current .mark { animation: none; } }
  .subs .mark { width: 10px; height: 10px; margin: 5px 2px 0; }
  .subs .row.done .mark::after { width: 2px; height: 4px; border-width: 0 1.3px 1.3px 0; }
  .subs .row.failed .mark::after { font-size: 9px; }

  /* Action icon (eye, pointer, keyboard, server …), so a step can be read at a glance. */
  .ico { width: 16px; height: 16px; margin-top: 2px; color: var(--muted); }
  .ico svg { width: 16px; height: 16px; display: block; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .row.current .ico { color: var(--accent); }
  .row.failed .ico { color: var(--bad); }

  .label { font-size: 13.5px; line-height: 1.45; word-break: break-word; }
  .row.done .label { color: color-mix(in srgb, var(--text) 75%, var(--panel)); }
  .row.current .label { font-weight: 600; color: var(--text); }
  .where { display: block; font-size: 12px; color: var(--muted); margin-top: 1px; }
  .time { font: 11px/1 ui-monospace, monospace; color: var(--muted); font-variant-numeric: tabular-nums;
    padding: 4px 6px; border-radius: 6px; margin-top: 1px; }
  .row.current .time { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .who { display: inline-block; font-size: 11px; font-weight: 650; padding: 0 6px; margin-right: 6px; border-radius: 6px;
    background: var(--accent-soft); color: var(--accent); vertical-align: 1px; }

  /* Story groups: a heading with a step count; open groups become a soft card holding their steps. */
  .g { margin: 2px 0; }
  .g > .row .label, .row.solo .label { font-weight: 600; }
  /* Group heading: [mark] [icon] [title + "4 steps"] [chevron] [time] */
  .row.gh { grid-template-columns: 16px 18px 1fr auto auto; }
  .gh .chev { margin: 0; }
  .g.open { background: color-mix(in srgb, var(--accent-soft) 35%, transparent); border-radius: 12px; margin: 4px 6px; padding: 2px 0 4px; }
  .g.open > .row, .g.open .subs .row { margin-left: 2px; margin-right: 2px; }
  .g.open > .row.current { background: none; box-shadow: none; }
  .n { display: inline-block; font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 6px; white-space: nowrap; }
  .chev { border: 0; background: none; padding: 3px; margin: 0; color: var(--muted); cursor: pointer;
    display: inline-grid; place-items: center; vertical-align: middle; border-radius: 6px; transition: transform .2s, background .15s; }
  .chev:hover { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--text); }
  .chev svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .g.open .chev { transform: rotate(90deg); }
  .subs { display: none; }
  .g.open .subs { display: block; }
  .subs .label { font-size: 13px; }
  .subs .ico, .subs .ico svg { width: 14px; height: 14px; }
  .subs .ico { margin-top: 3px; }

  .req { font: 11.5px/1.5 ui-monospace, monospace; color: var(--muted); margin-top: 3px; }
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

// Small line icons (from the lucide set, like the rest of HumanTest's UI), picked from the plain words.
const ICONS = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pointer: '<path d="M9 9l5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  reload: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  person: '<circle cx="12" cy="4.5" r="2"/><path d="M5 9l7 1 7-1M12 10v5l-3 6M12 15l3 6"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14 0M1.4 9a16 16 0 0 1 21.2 0M8.5 16.4a6 6 0 0 1 7 0M12 20h.01"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};
const iconFor = (text) =>
  /^Opens/.test(text) ? 'globe' :
  /^Reloads/.test(text) ? 'reload' :
  /^(Types|Enters|Presses|The cursor)/.test(text) ? 'keyboard' :
  /^Picks/.test(text) ? 'list' :
  /^Clicks/.test(text) ? 'pointer' :
  /^(Sees|Doesn't see|Is still on)/.test(text) ? 'eye' :
  / dialog /.test(text) ? 'window' :
  /^(The app sends|Server|Nothing is sent|The answer|Calls|Makes)/.test(text) ? 'server' :
  /^Checks accessibility/.test(text) ? 'person' :
  /^Starts with/.test(text) ? 'database' :
  /^Waits/.test(text) ? 'clock' :
  /^Turns the internet/.test(text) ? 'wifi' : 'check';
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';

// storyTitle: a story line with just this one step. It shows as one row: the story on top, the step under it.
function makeRow(s, isSub, storyTitle) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'row' + (s.status === 'failed' ? ' failed' : '') + (storyTitle ? ' solo' : '');
  row.title = 'Line ' + s.line + ' of the test: ' + ownText(s);
  const h = say(s);
  const body = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'label';
  if (multiUser && !isSub && s.user !== 'setup') { const w = document.createElement('span'); w.className = 'who'; w.textContent = s.user; label.append(w); }
  label.append(document.createTextNode(storyTitle ? cap(storyTitle) : h.text));
  body.append(label);
  const detail = storyTitle ? h.text + (h.where ? ' · in ' + h.where : '') : (h.where ? 'in ' + h.where : '');
  if (detail) { const w = document.createElement('span'); w.className = 'where'; w.textContent = detail; body.append(w); }
  for (const r of D.requests.filter((r) => r.user === s.user && r.at >= s.start - 50 && r.at <= s.end + 50)) {
    const d = document.createElement('div');
    d.className = 'req' + ((r.status ?? 0) >= 400 ? ' bad' : '');
    d.textContent = r.method + ' ' + r.path + ' → ' + (r.status ?? '…') + (r.simulated ? ' (simulated)' : '');
    body.append(d);
  }
  if (s.error) { const d = document.createElement('div'); d.className = 'err'; d.textContent = cleanError(s.error); body.append(d); }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmt(s.start);
  const mark = document.createElement('span');
  mark.className = 'mark';
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = svg(iconFor(h.text));
  row.append(mark, ico, body, time);
  row.addEventListener('click', (e) => { e.stopPropagation(); seek(s.start + 1); });
  li.append(row);
  return { li, row };
}

// A story line ("the dentist adds a … issue") becomes a group that opens to show its steps.
const stepsBox = $('steps');
const stepEls = new Array(D.steps.length);
const groups = [];
const storyKey = (x) => (x.text.includes(' › ') ? x.text.split(' › ')[0] + '|' + x.line : null);
for (let i = 0; i < D.steps.length; i++) {
  const s = D.steps[i];
  const key = storyKey(s);
  if (!key) {
    const { li, row } = makeRow(s, false);
    stepsBox.append(li);
    stepEls[i] = row;
    continue;
  }
  const idx = [];
  while (i < D.steps.length && storyKey(D.steps[i]) === key) idx.push(i++);
  i--;
  const first = D.steps[idx[0]];
  if (idx.length === 1) {
    // Nothing to open: one row with the story on top and its single step under it.
    const { li, row } = makeRow(first, false, first.text.split(' › ')[0]);
    stepsBox.append(li);
    stepEls[idx[0]] = row;
    continue;
  }
  const li = document.createElement('li');
  li.className = 'g';
  const head = document.createElement('div');
  head.className = 'row gh' + (idx.some((j) => D.steps[j].status === 'failed') ? ' failed' : '');
  head.title = 'Line ' + first.line + ' of the test';
  const body = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'label';
  if (multiUser && first.user !== 'setup') { const w = document.createElement('span'); w.className = 'who'; w.textContent = first.user; label.append(w); }
  label.append(document.createTextNode(cap(first.text.split(' › ')[0])));
  body.append(label);
  const n = document.createElement('span');
  n.className = 'where';
  n.textContent = idx.length + ' steps';
  body.append(n);
  const chev = document.createElement('button');
  chev.className = 'chev';
  chev.type = 'button';
  chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  chev.setAttribute('aria-label', 'Show or hide the steps of this part');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmt(first.start);
  const mark = document.createElement('span');
  mark.className = 'mark';
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';
  head.append(mark, ico, body, chev, time);
  const subs = document.createElement('ol');
  subs.className = 'subs';
  for (const j of idx) { const r = makeRow(D.steps[j], true); subs.append(r.li); stepEls[j] = r.row; }
  li.append(head, subs);
  stepsBox.append(li);
  const g = { li, head, idx, manual: null, failed: idx.some((j) => D.steps[j].status === 'failed') };
  groups.push(g);
  head.addEventListener('click', () => { g.manual = null; seek(first.start + 1); });
  chev.addEventListener('click', (e) => { e.stopPropagation(); g.manual = !li.classList.contains('open'); sync(false); });
}
for (const w of D.warnings) {
  const d = document.createElement('div');
  d.className = 'warn';
  d.textContent = '⚠ Hidden problem: ' + w.message + (multiUser ? ' (' + w.user + ')' : '');
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
  stepEls.forEach((el, i) => {
    el.classList.toggle('current', i === current);
    el.classList.toggle('done', i !== current && D.steps[i].start <= t);
  });
  for (const g of groups) {
    const has = g.idx.includes(current);
    g.head.classList.toggle('current', has);
    g.head.classList.toggle('done', !has && D.steps[g.idx[0]].start <= t);
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
