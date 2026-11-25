// ワークスペース画面の API（端末の操作・ファイルのプレビュー・画面用ライブラリの配信）。
// 端末はマシンを自由に操作できるので、ループバックからの接続で、かつトークンそのものを持つ場合だけ許可する。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackAddress, tokensEqual } from './auth.mjs';
import { createTerminals, NAME_RE, MODES } from './term.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = {
  '/vendor/xterm.js': ['xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['addon-fit.js', 'text/javascript; charset=utf-8'],
};
export const PREVIEW_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 30;
const MAX_BODY = 256 * 1024;
const MAX_VIEWERS = 8;

const MAX_DIRS = 200;
// ファイルを作成・編集するツール。古い版の hook は読んだだけのファイルも送るので、サーバー側でも絞る
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const expandHome = (p, home = os.homedir()) => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);

/** 入力中のパスに続くディレクトリの候補（シェルの Tab 補完用）。返す値は末尾が "/"。"~" で書かれていれば "~" のまま返す。 */
export function listDirs(input, home = os.homedir()) {
  const typed = input === '' || input === '~' ? '~/' : input;
  const full = expandHome(typed, home);
  if (!path.isAbsolute(full)) return [];
  const slash = typed.lastIndexOf('/');
  const head = typed.slice(0, slash + 1); // 利用者が書いた形のまま
  const base = typed.slice(slash + 1);
  let entries;
  try { entries = fs.readdirSync(expandHome(head, home), { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => {
    if (e.name.startsWith('.') && !base.startsWith('.')) return false;
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(expandHome(head, home), e.name)).isDirectory(); } catch { return false; }
  }).map((e) => e.name);
  let hit = dirs.filter((n) => n.startsWith(base));
  if (!hit.length) hit = dirs.filter((n) => n.toLowerCase().startsWith(base.toLowerCase()));
  return hit.sort((a, b) => a.localeCompare(b)).slice(0, MAX_DIRS).map((n) => `${head}${n}/`);
}

const previewType = (p) => PREVIEW_TYPES[path.extname(p).toLowerCase()];

/** /event で受けた内容から、セッションに端末との対応と、作成・編集したプレビューできるファイルを記録する */
export function recordWorkspace(session, ev) {
  if (typeof ev.term === 'string' && NAME_RE.test(ev.term)) session.term = ev.term;
  if (ev.event !== 'PostToolUse' || !EDIT_TOOLS.has(ev.tool_name)) return;
  const f = ev.file;
  if (typeof f !== 'string' || f.length > 4096 || !path.isAbsolute(f) || !previewType(f)) return;
  session.files = (session.files || []).filter((x) => x.path !== f);
  session.files.push({ path: f, t: ev.t, tool: ev.tool_name });
  if (session.files.length > MAX_FILES) session.files.splice(0, session.files.length - MAX_FILES);
}

export function createWorkspace({ port, token, sessions, enabled = true }) {
  const terms = createTerminals({ port });
  const viewers = new Map(); // id -> attach の戻り値

  const json = (res, status, obj) => res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  }).end(JSON.stringify(obj));

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve(null);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });

  function stream(req, res, url) {
    if (viewers.size >= MAX_VIEWERS) return json(res, 429, { error: 'too many viewers' });
    const name = url.searchParams.get('name') || '';
    if (!NAME_RE.test(name)) return json(res, 400, { error: 'invalid name' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const id = crypto.randomBytes(12).toString('hex');
    res.write(`event: attached\ndata: ${JSON.stringify({ id })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    const view = terms.attach(name, {
      cols: Number(url.searchParams.get('cols')),
      rows: Number(url.searchParams.get('rows')),
      onData: (buf) => res.write(`data: ${buf.toString('base64')}\n\n`),
      onExit: () => {
        clearInterval(ping);
        viewers.delete(id);
        if (!res.writableEnded) res.end('event: exit\ndata: {}\n\n');
      },
    });
    viewers.set(id, view);
    res.on('close', () => view.close());
  }

  // hook から記録されたファイルだけを返す（任意のパスは読めない）
  function file(res, url) {
    const s = sessions.get(url.searchParams.get('session') || '');
    const p = url.searchParams.get('path') || '';
    if (!s?.files?.some((f) => f.path === p)) return json(res, 404, { error: 'not found' });
    let data;
    let type;
    try {
      const real = fs.realpathSync(p);
      type = previewType(real); // リンク先も対象の拡張子であること
      const st = fs.statSync(real);
      if (!type || !st.isFile()) return json(res, 404, { error: 'not found' });
      if (st.size > MAX_FILE) return json(res, 413, { error: 'file too large' });
      data = fs.readFileSync(real);
    } catch { return json(res, 404, { error: 'not found' }); }
    // SVG などを直接開いても、スクリプトを実行させない
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    }).end(data);
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/term') {
      return json(res, 200, { available: await terms.available(), socket: terms.socket, modes: Object.keys(MODES), terms: await terms.list() });
    }
    if (route === 'GET /api/term/stream') return stream(req, res, url);
    if (route === 'GET /api/term/dirs') return json(res, 200, { dirs: listDirs((url.searchParams.get('prefix') || '').slice(0, 4096)) });
    if (route === 'GET /api/file') return file(res, url);
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    // 書き込みはヘッダのトークンだけを認める（URL の ?key= では操作させない）
    if (!tokensEqual(req.headers['x-agent-viz-token'], token)) return json(res, 401, { error: 'bad token' });
    const b = await readBody(req);
    if (!b) return json(res, 400, { error: 'invalid body' });
    if (url.pathname === '/api/term/create') {
      try {
        const cwd = typeof b.cwd === 'string' ? path.normalize(expandHome(b.cwd)).replace(/(?<=.)\/$/, '') : b.cwd;
        return json(res, 200, await terms.create({ cwd, mode: b.mode }));
      }
      catch (e) { return json(res, 400, { error: e.stderr || e.message }); }
    }
    if (url.pathname === '/api/term/kill') {
      return (await terms.kill(String(b.name || ''))) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    }
    const view = viewers.get(b.id);
    if (!view) return json(res, 404, { error: 'not found' });
    if (url.pathname === '/api/term/input') {
      if (typeof b.data !== 'string') return json(res, 400, { error: 'invalid data' });
      view.write(Buffer.from(b.data, 'base64'));
      return res.writeHead(204).end();
    }
    if (url.pathname === '/api/term/resize') {
      view.resize(b.cols, b.rows);
      return res.writeHead(204).end();
    }
    return json(res, 404, { error: 'not found' });
  }

  /** このモジュールの担当なら処理して true。Host / Origin の検証は呼び出し側で済んでいる前提。 */
  function handle(req, res, url) {
    if (req.method === 'GET' && Object.hasOwn(VENDOR, url.pathname)) {
      const [name, type] = VENDOR[url.pathname];
      fs.readFile(path.join(here, 'public', 'vendor', name), (err, buf) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' }).end(buf);
      });
      return true;
    }
    if (url.pathname !== '/api/file' && url.pathname !== '/api/term' && !url.pathname.startsWith('/api/term/')) return false;
    const got = req.headers['x-agent-viz-token'] ?? url.searchParams.get('key');
    if (!isLoopbackAddress(req.socket.remoteAddress)) json(res, 403, { error: 'loopback only' });
    else if (!tokensEqual(got, token)) json(res, 401, { error: 'bad token' });
    else if (!enabled && url.pathname !== '/api/file') json(res, 403, { error: 'terminal disabled' });
    else api(req, res, url).catch((e) => {
      console.error('workspace error', e.message);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
    return true;
  }

  return { handle };
}
