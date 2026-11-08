// A fake mail server for tests: the app sends its email here (SMTP, no TLS, any login),
// and the steps read it. Nothing ever leaves the machine.
//
// One mailbox per test worker, started on the first test whose config has "email". It keeps
// every message in memory; each test only looks at the ones that arrived after it started.

import net from 'node:net';

export interface Email {
  /** Order of arrival, from 0. */
  seq: number;
  at: number;
  from: string;
  /** Who it was sent to (the SMTP envelope, lowercase). */
  to: string[];
  subject: string;
  /** The readable text: the plain part, or the HTML part without its tags. */
  text: string;
  html?: string;
  /** Every link in it, with the words on it. */
  links: { text: string; href: string }[];
}

const mails: Email[] = [];
const waiters = new Set<() => void>();
let starting: Promise<void> | undefined;

/** Start the mailbox on `port` (once per worker). */
export function startMailbox(port: number): Promise<void> {
  starting ??= (async () => {
    // "localhost" is ::1 for some apps and 127.0.0.1 for others, so both. Never on the network.
    await listen(port, '127.0.0.1');
    await listen(port, '::1').catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRNOTAVAIL' && e.code !== 'EAFNOSUPPORT') throw e; // no IPv6 here
    });
  })().catch((e) => { starting = undefined; throw e; });
  return starting;
}

function listen(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(session);
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} for the test mailbox ("email.port" in humantest.config.json) is already in use. Stop what uses it, or pick another port (and point the app's SMTP settings at it).`)
      : e));
    server.listen(port, host, () => {
      server.unref();
      resolve();
    });
  });
}

export const allMail = (): readonly Email[] => mails;

/** Wait until `test` finds a message, for up to `ms`. */
export async function waitForMail<T>(find: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = find();
    if (hit !== undefined) return hit;
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.min(left, 250));
      waiters.add(done);
    });
  }
}

// ---------------- SMTP ----------------

function session(socket: net.Socket) {
  socket.setEncoding('latin1');
  const reply = (line: string) => socket.write(`${line}\r\n`);
  let from = '';
  let to: string[] = [];
  let buffer = '';
  let inData = false;
  let authStep: 'user' | 'pass' | undefined;

  reply('220 humantest mailbox ready');
  socket.on('error', () => { /* the app hung up */ });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        // An empty message ends right away with ".\r\n".
        const empty = buffer.startsWith('.\r\n');
        if (end < 0 && !empty) return;
        const raw = empty ? '' : buffer.slice(0, end);
        buffer = buffer.slice(empty ? 3 : end + 5);
        inData = false;
        receive(from, to, raw.replace(/^\.\./gm, '.'));
        from = '';
        to = [];
        reply('250 OK: kept');
        continue;
      }
      const nl = buffer.indexOf('\r\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (authStep) {
        reply(authStep === 'user' ? '334 UGFzc3dvcmQ6' : '235 OK');
        authStep = authStep === 'user' ? 'pass' : undefined;
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') { reply('250-humantest'); reply('250-AUTH PLAIN LOGIN'); reply('250-8BITMIME'); reply('250 SMTPUTF8'); }
      else if (verb === 'HELO') reply('250 humantest');
      else if (verb === 'AUTH') {
        // Any login is fine: AUTH PLAIN <data>, AUTH PLAIN (then data), AUTH LOGIN (user, then password).
        const [, mech, initial] = line.split(/\s+/);
        if (/^login$/i.test(mech)) { reply(initial ? '334 UGFzc3dvcmQ6' : '334 VXNlcm5hbWU6'); authStep = initial ? 'pass' : 'user'; }
        else if (initial) reply('235 OK');
        else { reply('334 '); authStep = 'pass'; }
      }
      else if (verb === 'MAIL') { from = address(line); to = []; reply('250 OK'); }
      else if (verb === 'RCPT') { to.push(address(line).toLowerCase()); reply('250 OK'); }
      else if (verb === 'DATA') { inData = true; reply('354 End with <CRLF>.<CRLF>'); }
      else if (verb === 'RSET') { from = ''; to = []; reply('250 OK'); }
      else if (verb === 'QUIT') { reply('221 Bye'); socket.end(); return; }
      else if (verb === 'NOOP') reply('250 OK');
      else reply('502 Not supported');
    }
  });
}

const address = (line: string) => /<([^>]*)>/.exec(line)?.[1] ?? line.split(':').slice(1).join(':').trim();

function receive(envelopeFrom: string, envelopeTo: string[], raw: string) {
  const msg = parsePart(raw);
  const texts: string[] = [];
  const htmls: string[] = [];
  collect(msg, texts, htmls);
  const html = htmls.join('\n') || undefined;
  const text = (texts.length ? texts.join('\n') : html ? htmlToText(html) : '').trim();
  const links = html ? linksIn(html) : [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => ({ text: m[0], href: m[0] }));
  mails.push({
    seq: mails.length,
    at: Date.now(),
    from: decodeWords(msg.headers.from ?? envelopeFrom),
    to: envelopeTo.length ? envelopeTo : (msg.headers.to ?? '').split(',').map((a) => address(a).toLowerCase()),
    subject: decodeWords(msg.headers.subject ?? ''),
    text,
    html,
    links,
  });
  for (const w of [...waiters]) w();
}

// ---------------- MIME, just enough for what apps send ----------------

interface Part { headers: Record<string, string>; body: string; parts?: Part[] }

function parsePart(raw: string): Part {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
      .filter((p) => p.trim() && !/^--\s*$/.test(p.trim()))
      .map(parsePart);
    return { headers, body: '', parts };
  }
  return { headers, body };
}

function collect(part: Part, texts: string[], htmls: string[]) {
  if (part.parts) { for (const p of part.parts) collect(p, texts, htmls); return; }
  const type = (part.headers['content-type'] ?? 'text/plain').toLowerCase();
  if (/attachment/i.test(part.headers['content-disposition'] ?? '')) return;
  const charset = /charset="?([^";]+)"?/i.exec(type)?.[1];
  const text = decodeBody(part.body, part.headers['content-transfer-encoding'], charset);
  if (type.startsWith('text/html')) htmls.push(text);
  else if (type.startsWith('text/plain')) texts.push(text);
}

function decodeBody(body: string, encoding = '', charset = 'utf-8'): string {
  const enc = encoding.toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
    : enc === 'quoted-printable' ? qpBytes(body)
    : Buffer.from(body, 'latin1');
  return /^(us-ascii|utf-?8)$/i.test(charset) ? bytes.toString('utf8') : bytes.toString('latin1');
}

function qpBytes(s: string): Buffer {
  const out: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) { out.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** =?UTF-8?B?…?= and =?UTF-8?Q?…?= in headers. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=\s*/gi, (_m, charset: string, kind: string, data: string) => {
    const bytes = kind.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : qpBytes(data.replace(/_/g, ' '));
    return /utf-?8/i.test(charset) ? bytes.toString('utf8') : bytes.toString('latin1');
  }).trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entities = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

export function htmlToText(html: string): string {
  return entities(html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function linksIn(html: string) {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: entities(m[1] ?? m[2]), text: htmlToText(m[3]) }))
    .filter((l) => /^https?:/i.test(l.href));
}
