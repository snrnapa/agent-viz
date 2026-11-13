// 認証まわり: トークンの保管と、Host / Origin / Sec-Fetch-Site の検証。依存ゼロ。
// 設計は docs/board-input-design.md の「認証」を参照。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const TOKEN_RE = /^[0-9a-f]{48}$/;
const isPosix = typeof process.getuid === 'function';

function dirCandidates() {
  const uid = isPosix ? process.getuid() : 'u';
  return [
    path.join(os.homedir(), '.agent-viz'),
    path.join(os.tmpdir(), `agent-viz-${uid}`),
  ];
}

// 他のユーザーに読み書きされないディレクトリか（所有者が自分で、group/other の権限が無い）
function privateDirOk(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    if (isPosix && st.uid !== process.getuid()) return false;
    if (isPosix && (st.mode & 0o077) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  if (privateDirOk(dir)) return true;
  try { fs.chmodSync(dir, 0o700); } catch { return false; }
  return privateDirOk(dir);
}

/** hook など「読むだけ」の側が使う。見つからなければ null。 */
export function readToken(port) {
  for (const dir of dirCandidates()) {
    if (!privateDirOk(dir)) continue;
    try {
      const t = fs.readFileSync(path.join(dir, `token-${port}`), 'utf8').trim();
      if (TOKEN_RE.test(t)) return t;
    } catch {}
  }
  return null;
}

/** サーバー起動時に呼ぶ。既存のトークンがあれば再利用する（再起動してもタブが生き続ける）。 */
export function loadOrCreateToken(port) {
  const existing = readToken(port);
  if (existing) return { token: existing, persisted: true };
  const token = crypto.randomBytes(24).toString('hex');
  for (const dir of dirCandidates()) {
    try {
      if (!ensurePrivateDir(dir)) continue;
      const file = path.join(dir, `token-${port}`);
      fs.writeFileSync(file, token + '\n', { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch {}
      return { token, persisted: true };
    } catch {}
  }
  return { token, persisted: false };
}

export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 許可する Host ヘッダの集合（小文字）。extra はカンマ区切り。 */
export function allowedHosts(port, extra = '') {
  const set = new Set(LOOPBACK_HOSTS.map((h) => `${h}:${port}`));
  for (const h of String(extra).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) set.add(h);
  return set;
}

export function hostAllowed(hostHeader, allowed) {
  return typeof hostHeader === 'string' && allowed.has(hostHeader.toLowerCase());
}

/** Origin が無ければ許可（hook や curl）。あれば http で、Host と同じ集合に含まれること。 */
export function originAllowed(origin, allowed) {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && allowed.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const fail = (status, reason) => ({ ok: false, status, reason });

/**
 * リクエストを検証する。
 * @param req http.IncomingMessage
 * @param opts { allowed: Set<string>, token: string, needToken: boolean }
 * @returns {{ok:true}|{ok:false,status:number,reason:string}}
 */
export function checkRequest(req, { allowed, token, needToken }) {
  if (!hostAllowed(req.headers.host, allowed)) return fail(403, 'bad host');
  if (!originAllowed(req.headers.origin, allowed)) return fail(403, 'bad origin');
  const site = req.headers['sec-fetch-site'];
  // 他サイトのリンクから開くトップレベルの移動は許可する（結果は相手のページから読めない）。
  // 埋め込み（iframe）は navigate ではなく、サーバー側で frame-ancestors で拒否する。
  const navigation = req.method === 'GET'
    && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document';
  if (site && site !== 'same-origin' && site !== 'none' && !navigation) return fail(403, 'cross-site');
  if (needToken && !tokensEqual(req.headers['x-agent-viz-token'], token)) return fail(401, 'bad token');
  return { ok: true };
}

/**
 * Linux のみ: ループバックで接続してきたソケットの所有者 UID を /proc/net/tcp{,6} から調べる。
 * 同じマシンの別ユーザーが 127.0.0.1 に接続してトークンを受け取るのを防ぐために使う。
 * 調べられなければ null。
 */
export function peerUid(clientPort, serverPort) {
  if (process.platform !== 'linux' || !Number.isInteger(clientPort) || !Number.isInteger(serverPort)) return null;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 8) continue;
      // c[1] = 自分側 "アドレス:ポート"、c[2] = 相手側、c[7] = ソケット所有者の UID
      const lport = parseInt(c[1].split(':')[1], 16);
      const rport = parseInt(c[2].split(':')[1], 16);
      if (lport === clientPort && rport === serverPort) return Number(c[7]);
    }
  }
  return null;
}

/**
 * ページにトークンを埋め込んでよい相手か。
 * - `?key=` が一致すれば常に可。
 * - strict なら `?key=` のみ。
 * - ループバックからで、かつ接続元が自分と同じ UID（Linux で確認できたとき）なら可。
 *   確認できない環境（macOS など）は、trustLoopback（AGENT_VIZ_TRUST_LOOPBACK=1）のときだけ可。
 */
export function mayReceiveToken(req, url, token, { strict = false, trustLoopback = false, serverPort } = {}) {
  if (tokensEqual(url.searchParams.get('key'), token)) return true;
  if (strict) return false;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (trustLoopback) return true;
  if (!isPosix) return false;
  const uid = peerUid(req.socket.remotePort, serverPort);
  return uid !== null && uid === process.getuid();
}
