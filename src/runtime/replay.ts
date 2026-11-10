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
  /* The page is a column: header, banner, main, controls. main takes what is left, so nothing slides under the controls. */
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
  header, .banner, footer { flex: none; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; }
  header .src { color: var(--muted); font-size: 12px; margin-left: auto; font-family: ui-monospace, monospace; }
  .badge { font-size: 12px; font-weight: 650; padding: 2px 10px; border-radius: 999px; }
  .badge.passed { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .badge.failed { background: var(--bad-soft); color: var(--bad); }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 16px; padding: 16px 20px; flex: 1; min-height: 0; }
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
  .tip { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); background: rgb(17 24 39 / .92); color: #fff; font-size: 12px;
    padding: 5px 10px; border-radius: 8px; box-shadow: 0 6px 20px rgb(0 0 0 / .35); border: 1px solid rgb(255 255 255 / .08); backdrop-filter: blur(6px); z-index: 3; white-space: nowrap; pointer-events: none; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
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
  .row > div { min-width: 0; }
  /* Scrolling to a step keeps it clear of the sticky "Steps" heading. */
  .row { scroll-margin-top: 56px; scroll-margin-bottom: 12px; }
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
  /* The failure, laid out in parts: headline, what the page shows, where the problem is, recent requests. */
  .err { margin-top: 8px; font-size: 12.5px; line-height: 1.5; color: var(--text); cursor: auto;
    background: color-mix(in srgb, var(--bad) 7%, var(--panel)); border: 1px solid color-mix(in srgb, var(--bad) 28%, var(--line));
    border-left: 3px solid var(--bad); border-radius: 10px; padding: 10px 12px; display: grid; gap: 9px; }
  .err-head { font-weight: 600; color: var(--bad); }
  .err.short { padding: 7px 10px; }
  .err-label { display: block; font-size: 10.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
  .err-p { margin: 0; color: color-mix(in srgb, var(--text) 85%, var(--panel)); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--text); }
  .pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 650; padding: 2px 9px; border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--text); }
  .pill.fe { background: color-mix(in srgb, #a855f7 16%, transparent); color: color-mix(in srgb, #a855f7 75%, var(--text)); }
  .pill.be { background: color-mix(in srgb, #f97316 16%, transparent); color: color-mix(in srgb, #f97316 75%, var(--text)); }
  .err-where .err-p { margin-top: 5px; }
  .err-reqs { display: grid; gap: 2px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); padding: 4px 0; }
  .rq { display: grid; grid-template-columns: 46px 1fr auto; gap: 8px; align-items: center; padding: 2px 9px; font: 11.5px/1.5 ui-monospace, monospace; }
  .rq .m { color: var(--muted); font-weight: 650; }
  .rq .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rq .s { font-weight: 650; padding: 0 6px; border-radius: 6px; }
  .rq .s.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .rq .s.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
  .warn { margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 1.45;
    background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
  .banner { display: flex; align-items: center; gap: 12px; margin: 12px 20px 0; padding: 10px 12px; border-radius: 12px;
    background: color-mix(in srgb, var(--bad) 7%, var(--panel)); border: 1px solid color-mix(in srgb, var(--bad) 28%, var(--line)); }
  .banner[hidden] { display: none; }
  .banner .b-ico { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700;
    background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .banner .b-txt { flex: 1; min-width: 0; }
  .banner .b-title { font-weight: 650; color: var(--bad); }
  .banner .b-why { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Inside the HumanTest UI the failure is already shown above the video. */
  body.embed .banner { display: none; }
  footer { height: 64px; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: var(--panel); border-top: 1px solid var(--line); }
  button { font: 500 13px/1 system-ui, sans-serif; height: 32px; border: 1px solid var(--line); background: var(--panel); color: var(--text);
    border-radius: 8px; padding: 0 11px; cursor: pointer; transition: background .15s, border-color .15s, color .15s; white-space: nowrap; }
  button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  button.on { background: var(--accent-soft); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  #play { width: 38px; height: 38px; padding: 0; border-radius: 50%; background: var(--accent); color: #fff; border-color: var(--accent);
    display: inline-grid; place-items: center; }
  #play:hover { filter: brightness(1.08); }
  /* Lucide-style line icons, drawn in the button's text colour. */
  button { display: inline-flex; align-items: center; gap: 6px; }
  button[hidden] { display: none; }
  .i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  #play .i { width: 16px; height: 16px; fill: currentColor; stroke: none; }
  #play .i-pause, #play.playing .i-play { display: none; }
  #play.playing .i-pause { display: inline; }
  #play:not(.playing) .i { transform: translateX(1px); }
  #full { width: 32px; padding: 0; justify-content: center; }
  #full .i-min, .is-full #full .i-max { display: none; }
  .is-full #full .i-min { display: inline; }
  #speeds { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--muted) 8%, transparent); }
  #speeds button { height: 26px; border: 0; background: none; color: var(--muted); padding: 0 9px; border-radius: 7px; }
  #speeds button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .18), 0 0 0 1px var(--line); }
  /* The timeline: a native range for input, drawn over by a rail, the played part, a hover preview and step notches.
     --p is how far it has played and --h where the mouse is, both 0 to 100. */
  .track { --p: 0; --h: 0; --rail: 4px; position: relative; flex: 1; height: 34px; cursor: pointer; }
  .track:hover, .track:focus-within { --rail: 6px; }
  /* Inset by half the 14px thumb, which is how far the native thumb's centre travels. */
  .rail, .fill, .hov { position: absolute; left: 7px; top: 50%; height: var(--rail); transform: translateY(-50%); border-radius: 999px;
    pointer-events: none; transition: height .15s ease; }
  .rail { right: 7px; background: color-mix(in srgb, var(--muted) 24%, transparent); }
  .hov { width: calc((100% - 14px) * var(--h) / 100); background: color-mix(in srgb, var(--text) 16%, transparent); opacity: 0; transition: height .15s ease, opacity .15s; }
  .track:hover .hov { opacity: 1; }
  .fill { width: calc((100% - 14px) * var(--p) / 100); background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 70%, #a78bfa), var(--accent));
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 45%, transparent); }
  .track input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; background: none; -webkit-appearance: none; appearance: none;
    cursor: pointer; z-index: 2; }
  .track input:focus { outline: none; }
  .track input::-webkit-slider-runnable-track { height: 100%; background: none; }
  .track input::-moz-range-track { height: 100%; background: none; }
  .track input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: 10px; border-radius: 50%; background: #fff; border: 0;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent), 0 2px 6px rgb(0 0 0 / .35); transition: transform .15s ease; }
  .track input::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 0;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent), 0 2px 6px rgb(0 0 0 / .35); transition: transform .15s ease; }
  .track:hover input::-webkit-slider-thumb, .track input:active::-webkit-slider-thumb { transform: scale(1.2); }
  .track:hover input::-moz-range-thumb, .track input:active::-moz-range-thumb { transform: scale(1.2); }
  .track input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--accent), 0 2px 6px rgb(0 0 0 / .35); }
  /* Each step starts at a notch cut into the rail; the failed one is a red dot with a soft glow. */
  .tick { position: absolute; top: 50%; width: 2px; height: calc(var(--rail) + 4px); transform: translate(-50%, -50%); border-radius: 1px;
    background: var(--panel); pointer-events: none; z-index: 1; transition: height .15s ease; }
  .tick.failed { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); border: 2px solid var(--panel);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 30%, transparent), 0 0 10px color-mix(in srgb, var(--bad) 60%, transparent); }
  #time { font-family: ui-monospace, monospace; color: var(--muted); min-width: 110px; text-align: right; }
  .note { color: var(--muted); padding: 40px; }
  @media (max-width: 900px) {
    body { height: auto; overflow: visible; }
    main { grid-template-columns: 1fr; flex: none; }
    footer { position: sticky; bottom: 0; overflow-x: auto; }
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
  <button id="play" title="Play / pause (space)" aria-label="Play"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M6 4.5a1.5 1.5 0 0 1 2.26-1.3l11.5 7a1.5 1.5 0 0 1 0 2.6l-11.5 7A1.5 1.5 0 0 1 6 18.5z"/><g class="i-pause"><rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/></g></svg></button>
  <div class="track" id="track"><div class="rail"></div><div class="hov"></div><div class="fill"></div><input id="seek" type="range" min="0" step="10" value="0" aria-label="Position"><div class="tip" id="tip" hidden></div></div>
  <span id="time">0:00 / 0:00</span>
  <span id="speeds"></span>
  <button id="zoom" title="Zoom in on each action (z)" aria-pressed="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.9-3.9M11 8v6M8 11h6"/></svg>Zoom</button>
  <button id="cc" title="Captions (c)" aria-pressed="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>Captions</button>
  <button id="side" title="Show or hide the steps (s)" aria-pressed="true"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M15 3v18"/></svg>Steps</button>
  <button id="full" title="Fullscreen (f)" aria-label="Fullscreen"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><g class="i-max"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></g><g class="i-min"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></g></svg></button>
</footer>
<script>
const D = __DATA__;
const $ = (id) => document.getElementById(id);
// Inside the HumanTest UI (?embed), the UI already shows the title and status.
if (new URLSearchParams(location.search).has('embed')) {
  // style.display, not .hidden: the header's own "display: flex" would win over the hidden attribute.
  document.querySelector('header').style.display = 'none';
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
// humanize is copied from the tool's own code; some loaders (tsx, esbuild) wrap functions in __name(), which a page doesn't have.
var __name = (f) => f;
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
  if (s.error) body.append(errorCard(s.error));
}
// The runtime's error text, laid out: headline, "the page shows" chips, where the problem is, recent requests.
function errorCard(text) {
  const box = el('div', 'err');
  box.addEventListener('click', (e) => e.stopPropagation());
  const lines = cleanError(text).split('\\n');
  // Embedded in the HumanTest UI, the page around the video already lays the failure out in full,
  // so the sidebar keeps only the headline instead of a second copy.
  if (document.body.classList.contains('embed')) { box.classList.add('short'); box.append(el('div', 'err-head', lines[0])); return box; }
  let reqs = null, where = null, m;
  lines.forEach((l, i) => {
    if (i === 0) { box.append(el('div', 'err-head', l)); return; }
    if ((m = l.match(/^Instead, the page shows:\\s*(.*)$/))) {
      const part = el('div');
      part.append(el('span', 'err-label', 'Instead, the page shows'));
      const chips = el('div', 'chips');
      for (const q of m[1].match(/"[^"]*"/g) || [m[1]]) chips.append(el('span', 'chip', q.replace(/^"|"$/g, '')));
      part.append(chips);
      box.append(part); reqs = where = null; return;
    }
    if ((m = l.match(/^Where the problem is:\\s*(.*)$/))) {
      where = el('div', 'err-where');
      where.append(el('span', 'err-label', 'Where the problem is'));
      where.append(el('span', 'pill' + (/Frontend/.test(m[1]) ? ' fe' : /Backend/.test(m[1]) ? ' be' : ''), m[1]));
      box.append(where); reqs = null; return;
    }
    if (/^Latest backend activity:?$/.test(l)) {
      const part = el('div');
      part.append(el('span', 'err-label', 'Latest backend activity'));
      reqs = el('div', 'err-reqs');
      part.append(reqs); box.append(part); where = null; return;
    }
    if (reqs && (m = l.match(/^([A-Z]+)\\s+(\\S+)\\s+→\\s+(.+)$/))) {
      const r = el('div', 'rq');
      const code = parseInt(m[3], 10);
      r.append(el('span', 'm', m[1]), el('span', 'p', m[2]), el('span', 's' + (code >= 400 ? ' bad' : code ? ' ok' : ''), m[3]));
      r.title = l;
      reqs.append(r); return;
    }
    reqs = null;
    // The line after "Where the problem is" explains it; keep it under the badge.
    if (where) { where.append(el('p', 'err-p', l)); where = null; return; }
    box.append(el('p', 'err-p', l));
  });
  return box;
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
    k.style.left = 'calc(7px + (100% - 14px) * ' + (s.start / total) + ')';
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
  $('track').style.setProperty('--p', String(total ? Math.min(100, (t / total) * 100) : 0));
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
  $('play').classList.toggle('playing', on);
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
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
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-full', !!document.fullscreenElement);
  $('full').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
});

// ---------- hovering the timeline names the step at that moment ----------
const track = $('track'), tip = $('tip');
track.addEventListener('mousemove', (e) => {
  const box = track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - box.left - 7) / (box.width - 14)));
  const at = frac * total;
  track.style.setProperty('--h', String(frac * 100));
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
  const txt = el('div', 'b-txt');
  txt.append(el('div', 'b-title', 'Failed: ' + say(failed).text + (multiUser ? ' (' + failed.user + ')' : '')));
  if (why) txt.append(el('div', 'b-why', why));
  const go = el('button', null, 'Show the step');
  go.addEventListener('click', () => { seek(Math.max(0, failed.start - 1500)); stepEls[D.steps.indexOf(failed)].scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  $('banner').append(el('span', 'b-ico', '✕'), txt, go);
  setTimeout(() => { seek(Math.max(0, failed.start - 1500)); stepEls[D.steps.indexOf(failed)].scrollIntoView({ block: 'start' }); }, 300);
}
durations();
sync(true);
</script>
</body>
</html>
`;
