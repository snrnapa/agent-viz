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
export function peerUid({ remoteAddress, remotePort, localAddress, localPort } = {}) {
  if (process.platform !== 'linux' || !Number.isInteger(remotePort) || !Number.isInteger(localPort)) return null;
  // 接続の4つ組（クライアントのアドレス:ポート → サーバーのアドレス:ポート）を、アドレスまで含めて照合する。
  // ポートだけで照合すると、別のアドレス・別のアドレス族の接続（例: ::1 と 127.0.0.1）と取り違える。
  const clientAddrs = procAddrForms(remoteAddress);
  const serverAddrs = procAddrForms(localAddress);
  if (!clientAddrs.length || !serverAddrs.length) return null;
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  const wantLocal = new Set(clientAddrs.map((a) => `${a}:${hex4(remotePort)}`));
  const wantRemote = new Set(serverAddrs.map((a) => `${a}:${hex4(localPort)}`));
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      // c[1] = 自分側 "アドレス:ポート"、c[2] = 相手側、c[3] = 状態（01 = ESTABLISHED）、c[7] = ソケット所有者の UID
      if (c.length < 8 || c[3] !== '01') continue;
      if (wantLocal.has(c[1].toUpperCase()) && wantRemote.has(c[2].toUpperCase())) return Number(c[7]);
    }
  }
  return null;
}

// アドレスを /proc/net/tcp{,6} の16進表記に直す（IPv4 はリトルエンディアン8桁、IPv6 は32桁）。
// IPv4 と IPv4 射影（::ffff:a.b.c.d）は同じ接続でも別のテーブルに載るので両方返す。扱えなければ空配列。
function procAddrForms(addr) {
  const m = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(addr || ''));
  if (m) {
    const octets = m[1].split('.').map(Number);
    if (octets.some((n) => n > 255)) return [];
    const v4 = octets.reverse().map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
    return [v4, `0000000000000000FFFF0000${v4}`];
  }
  if (addr === '::1') return ['00000000000000000000000001000000'];
  return [];
}

/**
 * ページにトークンを埋め込んでよい相手か。
 * - `?key=` が一致すれば常に可。
 * - strict なら `?key=` のみ。
 * - ループバックからで、かつ接続元が自分と同じ UID（Linux で確認できたとき）なら可。
 *   確認できない環境（macOS など）は、trustLoopback（AGENT_VIZ_TRUST_LOOPBACK=1）のときだけ可。
 */
export function mayReceiveToken(req, url, token, { strict = false, trustLoopback = false } = {}) {
  if (tokensEqual(url.searchParams.get('key'), token)) return true;
  if (strict) return false;
  const s = req.socket;
  if (!isLoopbackAddress(s.remoteAddress)) return false;
  if (trustLoopback) return true;
  if (!isPosix) return false;
  const uid = peerUid({ remoteAddress: s.remoteAddress, remotePort: s.remotePort, localAddress: s.localAddress, localPort: s.localPort });
  return uid !== null && uid === process.getuid();
}
