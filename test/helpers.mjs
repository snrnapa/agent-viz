// テスト共通の補助。依存ゼロ（node:test / node:assert は呼び出し側で使う）。
// 起動するのは、このテストが spawn したサーバーとフックだけ。kill も自分の PID に限る。
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_PATH = path.join(ROOT, 'server', 'server.mjs');
export const ASK_PATH = path.join(ROOT, 'bin', 'ask.mjs');
export const AUTH_PATH = path.join(ROOT, 'server', 'auth.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// このテストが起動した子プロセスだけを追跡し、テストが途中で止まっても残さない（PID 指定で kill するだけ）
const liveChildren = new Set();
function track(child) {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}
function killTracked() {
  for (const c of liveChildren) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
}
process.once('exit', killTracked);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { killTracked(); process.exit(1); });
}

/** 一時 HOME（テスト終了時に removeDir で消す） */
export function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viz-test-'));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 子プロセス用の環境。利用者の AGENT_VIZ_* を持ち込まないよう、必要な変数だけ渡す。 */
export function childEnv(home, extra = {}) {
  return { PATH: process.env.PATH || '', HOME: home, TMPDIR: home, ...extra };
}

/** 空きポートを選ぶ（0 番に listen して閉じる） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 非ループバックの IPv4 アドレスが 1 つあれば返す。無ければ null。 */
export function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      const v4 = i.family === 'IPv4' || i.family === 4;
      if (v4 && !i.internal) return i.address;
    }
  }
  return null;
}

export function tokenPath(home, port) {
  return path.join(home, '.agent-viz', `token-${port}`);
}

/** 一時 HOME からトークンを読む */
export function readTokenFile(home, port) {
  return fs.readFileSync(tokenPath(home, port), 'utf8').trim();
}

/**
 * HTTP リクエスト。Host / Origin / Sec-Fetch-* など任意のヘッダを付けられるよう node:http を使う。
 * 応答は { status, headers, body } で返す。
 */
export function request(port, { host = '127.0.0.1', method = 'GET', path: urlPath = '/', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined
      ? undefined
      : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const h = { ...headers };
    if (payload !== undefined && h['content-length'] === undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host, port, method, path: urlPath, headers: h, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** JSON を POST する。token を渡すと x-agent-viz-token ヘッダを付ける。 */
export function postJson(port, urlPath, obj, { token, headers = {}, host, signal } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token !== undefined) h['x-agent-viz-token'] = token;
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return request(port, { host, method: 'POST', path: urlPath, headers: h, body, signal });
}

/** /api/ask を開く。promise は回答・時間切れ・切断のいずれかで解決（切断時は reject）。 */
export function openAsk(port, obj, { token, host } = {}) {
  const controller = new AbortController();
  const promise = postJson(port, '/api/ask', obj, { token, host, signal: controller.signal });
  promise.catch(() => {});
  return { promise, abort: () => controller.abort() };
}

export async function getState(port, opts = {}) {
  const r = await request(port, { host: opts.host, path: '/api/state', headers: opts.headers });
  return JSON.parse(r.body);
}

/** 条件を満たすまで待つ。満たしたら真の値、時間切れなら null。 */
export async function waitFor(fn, { timeout = 5000, interval = 40 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(interval);
  }
}

/** 盤面に出ている ask（kind 指定）を待つ */
export function waitForAsk(port, sessionId, kind, timeout = 5000) {
  return waitFor(async () => {
    const st = await getState(port);
    const s = st.sessions.find((x) => x.id === sessionId);
    return s?.asks.find((a) => a.kind === kind) ?? null;
  }, { timeout });
}

export function setPresence(port, token, visible, client = 'test-browser') {
  return postJson(port, '/api/presence', { client, visible }, { token });
}

/** セッションを作る（/event の UserPromptSubmit）。 */
export async function registerSession(port, sessionId, cwd = '/home/user/project') {
  return postJson(port, '/event', {
    event: 'UserPromptSubmit', session_id: sessionId, t: Date.now(), cwd, prompt: 'テストの依頼',
  });
}

/**
 * サーバーを子プロセスとして起動し、応答と token ファイルができるまで待つ。
 * opts.env: 追加の環境変数（関数なら port を受け取って返す）。
 * opts.probeHost: 起動確認に使うアドレス（既定 127.0.0.1）。
 * opts.port: 指定すると固定ポート（指定が無いときは空きポートを選び、ずれたら数回やり直す）。
 */
export async function startServer({ env = {}, port: fixedPort, probeHost = '127.0.0.1' } = {}) {
  const attempts = fixedPort ? 1 : 3;
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = fixedPort ?? (await freePort());
    const extra = typeof env === 'function' ? env(port) : env;
    const home = makeTempHome();
    const child = track(spawn(process.execPath, [SERVER_PATH], {
      env: childEnv(home, { AGENT_VIZ_PORT: String(port), ...extra }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const srv = { port, home, child, token: null, probeHost, output: () => output };

    const ready = await waitReady(srv);
    if (ready) {
      srv.token = readTokenFile(home, port);
      return srv;
    }
    last = output;
    await stopServer(srv);
  }
  throw new Error(`server did not start: ${last}`);
}

async function waitReady(srv) {
  let exited = false;
  srv.child.once('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    if (exited) return false;
    try {
      const r = await request(srv.port, { host: srv.probeHost, path: '/api/state' });
      if (r.status === 200 && fs.existsSync(tokenPath(srv.home, srv.port))) {
        // 起動直後に EADDRINUSE で終了する場合があるので、少し待って生存を確かめる
        await sleep(40);
        return !exited;
      }
    } catch {}
    await sleep(50);
  }
  return false;
}

/** 起動したサーバーを止め、一時 HOME を消す。 */
export async function stopServer(srv) {
  const c = srv.child;
  if (c.exitCode === null && c.signalCode === null) {
    const exited = once(c, 'exit');
    c.kill('SIGTERM');
    const force = setTimeout(() => c.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
  removeDir(srv.home);
}

/**
 * hook（bin/ask.mjs）を子プロセスで起動する。stdin に hook 入力 JSON を書いて閉じる。
 * done は { code, signal, stdout, stderr, ms, timedOut } で解決する。
 */
export function spawnHook(stdinText, env, { killAfter = 30000 } = {}) {
  const started = Date.now();
  const child = track(spawn(process.execPath, [ASK_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] }));
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  child.stdin.end(stdinText);
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, killAfter);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
  return { child, done };
}

/** 別プロセスで auth.mjs の関数を実行し、JSON で結果を受け取る（HOME などを差し替えるため）。 */
export function runAuthExpr(env, expr) {
  const url = pathToFileURL(AUTH_PATH).href;
  const code = `const a = await import(${JSON.stringify(url)});\nconsole.log(JSON.stringify(${expr}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}
