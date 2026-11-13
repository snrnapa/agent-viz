// server/auth.mjs の単体テスト。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as auth from '../server/auth.mjs';
import { childEnv, makeTempHome, removeDir, runAuthExpr } from './helpers.mjs';

const POSIX = typeof process.getuid === 'function';
const HEX48 = /^[0-9a-f]{48}$/;
const TOKEN = 'a'.repeat(48);

describe('loadOrCreateToken / readToken', () => {
  let home;
  before(() => { home = makeTempHome(); });
  after(() => removeDir(home));

  it('新規作成: 48 桁 hex のトークンを保存し、ファイルは 0600、ディレクトリは 0700', { skip: !POSIX ? 'POSIX のみ' : false }, () => {
    const r = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4101)');
    assert.equal(r.persisted, true);
    assert.match(r.token, HEX48);
    const file = path.join(home, '.agent-viz', 'token-4101');
    assert.equal(fs.readFileSync(file, 'utf8'), `${r.token}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.agent-viz')).mode & 0o777, 0o700);
  });

  it('既存のトークンは再利用する（再起動してもタブが生きる）', () => {
    const first = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4102)');
    const second = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4102)');
    assert.equal(second.token, first.token);
    assert.equal(second.persisted, true);
    assert.equal(runAuthExpr(childEnv(home), 'a.readToken(4102)'), first.token);
  });

  it('ポートごとに別のトークンになる', () => {
    const a = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4103)');
    const b = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4104)');
    assert.notEqual(a.token, b.token);
  });

  it('形式の合わないトークンファイルは読まず、作り直す', () => {
    fs.writeFileSync(path.join(home, '.agent-viz', 'token-4105'), 'not-a-token\n');
    assert.equal(runAuthExpr(childEnv(home), 'a.readToken(4105)'), null);
    const r = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4105)');
    assert.match(r.token, HEX48);
    assert.equal(runAuthExpr(childEnv(home), 'a.readToken(4105)'), r.token);
  });

  it('権限の緩いディレクトリは読まない。保存するときは 0700 に直す', { skip: !POSIX ? 'POSIX のみ' : false }, () => {
    const old = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4106)');
    const dir = path.join(home, '.agent-viz');
    fs.chmodSync(dir, 0o755);
    assert.equal(runAuthExpr(childEnv(home), 'a.readToken(4106)'), null);
    const r = runAuthExpr(childEnv(home), 'a.loadOrCreateToken(4106)');
    assert.equal(r.persisted, true);
    assert.notEqual(r.token, old.token);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  it('~/.agent-viz が作れないときは TMPDIR に退避する（所有者と権限は 0700）', { skip: !POSIX ? 'POSIX のみ' : false }, () => {
    const base = makeTempHome();
    try {
      const fileHome = path.join(base, 'not-a-dir');
      fs.writeFileSync(fileHome, 'x');
      const tmp = path.join(base, 'tmp');
      fs.mkdirSync(tmp);
      const r = runAuthExpr(childEnv(base, { HOME: fileHome, TMPDIR: tmp }), 'a.loadOrCreateToken(4107)');
      assert.equal(r.persisted, true);
      const file = path.join(tmp, `agent-viz-${process.getuid()}`, 'token-4107');
      assert.equal(fs.readFileSync(file, 'utf8').trim(), r.token);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      removeDir(base);
    }
  });

  it('保存先がどちらも使えないときは persisted: false（メモリだけ）', () => {
    const base = makeTempHome();
    try {
      const fileHome = path.join(base, 'home-file');
      const fileTmp = path.join(base, 'tmp-file');
      fs.writeFileSync(fileHome, 'x');
      fs.writeFileSync(fileTmp, 'x');
      const r = runAuthExpr(childEnv(base, { HOME: fileHome, TMPDIR: fileTmp }), 'a.loadOrCreateToken(4108)');
      assert.equal(r.persisted, false);
      assert.match(r.token, HEX48);
    } finally {
      removeDir(base);
    }
  });
});

describe('tokensEqual', () => {
  it('同じ文字列は true', () => assert.equal(auth.tokensEqual(TOKEN, 'a'.repeat(48)), true));
  it('長さが違う、または中身が違うと false', () => {
    assert.equal(auth.tokensEqual(TOKEN, 'a'.repeat(47)), false);
    assert.equal(auth.tokensEqual(TOKEN, 'b'.repeat(48)), false);
  });
  it('文字列でない値は false', () => {
    assert.equal(auth.tokensEqual(undefined, TOKEN), false);
    assert.equal(auth.tokensEqual(TOKEN, null), false);
    assert.equal(auth.tokensEqual(['a'], ['a']), false);
  });
});

describe('allowedHosts / hostAllowed', () => {
  it('ループバック 3 種（localhost / 127.0.0.1 / [::1]）のポート付きだけを許可する', () => {
    const set = auth.allowedHosts(4777);
    assert.deepEqual([...set].sort(), ['127.0.0.1:4777', '[::1]:4777', 'localhost:4777']);
  });
  it('追加分はカンマ区切り・前後空白・大文字小文字を正規化し、空の要素は捨てる', () => {
    const set = auth.allowedHosts(4777, ' MyHost.example:4777 , ,other:4777,');
    assert.equal(set.has('myhost.example:4777'), true);
    assert.equal(set.has('other:4777'), true);
    assert.equal(set.size, 5);
  });
  it('hostAllowed は Host を小文字にして比べる。無い・別ポート・別ホストは false', () => {
    const set = auth.allowedHosts(4777);
    assert.equal(auth.hostAllowed('LOCALHOST:4777', set), true);
    assert.equal(auth.hostAllowed('localhost:4778', set), false);
    assert.equal(auth.hostAllowed('evil.com:4777', set), false);
    assert.equal(auth.hostAllowed(undefined, set), false);
  });
});

describe('originAllowed', () => {
  const set = auth.allowedHosts(4777);
  it('Origin が無ければ許可（hook や curl）', () => assert.equal(auth.originAllowed(undefined, set), true));
  it('http で、許可された Host と同じ host:port なら許可（大文字も可）', () => {
    assert.equal(auth.originAllowed('http://localhost:4777', set), true);
    assert.equal(auth.originAllowed('http://LOCALHOST:4777', set), true);
  });
  it('https・別ポート・別ホスト・"null"・不正な文字列は拒否', () => {
    assert.equal(auth.originAllowed('https://localhost:4777', set), false);
    assert.equal(auth.originAllowed('http://localhost:9999', set), false);
    assert.equal(auth.originAllowed('http://evil.com', set), false);
    assert.equal(auth.originAllowed('null', set), false);
    assert.equal(auth.originAllowed('', set), false);
  });
});

describe('checkRequest', () => {
  const allowed = auth.allowedHosts(4777);
  const base = (headers = {}, method = 'GET') => ({ method, headers: { host: 'localhost:4777', ...headers } });
  const check = (req, needToken = false) => auth.checkRequest(req, { allowed, token: TOKEN, needToken });
  const code = (r) => (r.ok ? 'ok' : r.status);

  it('Host が無い・許可外なら 403', () => {
    assert.equal(code(check({ method: 'GET', headers: {} })), 403);
    assert.equal(code(check(base({ host: 'evil.com:4777' }))), 403);
  });
  it('Origin が許可外なら 403、許可内なら通る', () => {
    assert.equal(code(check(base({ origin: 'http://evil.com' }))), 403);
    assert.equal(code(check(base({ origin: 'http://localhost:4777' }))), 'ok');
  });
  it('sec-fetch-site が cross-site / same-site なら 403。same-origin と none は通る', () => {
    assert.equal(code(check(base({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }))), 403);
    assert.equal(code(check(base({ 'sec-fetch-site': 'same-site' }))), 403);
    assert.equal(code(check(base({ 'sec-fetch-site': 'same-origin' }))), 'ok');
    assert.equal(code(check(base({ 'sec-fetch-site': 'none' }))), 'ok');
  });
  it('他サイトからのトップレベル移動（GET・navigate・document）は許可する', () => {
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal(code(check(base(nav))), 'ok');
  });
  it('navigate の例外は GET だけ。POST・iframe・cors は 403', () => {
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal(code(check(base(nav, 'POST'))), 403);
    assert.equal(code(check(base({ ...nav, 'sec-fetch-dest': 'iframe' }))), 403);
    assert.equal(code(check(base({ ...nav, 'sec-fetch-mode': 'cors' }))), 403);
  });
  it('token が必要なら、無い・違うと 401、一致すれば通る。不要なら何も見ない', () => {
    assert.equal(code(check(base({}), true)), 401);
    assert.equal(code(check(base({ 'x-agent-viz-token': 'b'.repeat(48) }), true)), 401);
    assert.equal(code(check(base({ 'x-agent-viz-token': TOKEN }), true)), 'ok');
    assert.equal(code(check(base({}), false)), 'ok');
  });
  it('検証の順序: Host → Origin → Sec-Fetch-Site → token。上位で落ちたら正しい token でも通らない', () => {
    assert.equal(code(check(base({ host: 'evil.com', 'x-agent-viz-token': TOKEN }), true)), 403);
    assert.equal(code(check(base({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'x-agent-viz-token': TOKEN }), true)), 403);
  });
});

describe('mayReceiveToken（strict / trustLoopback を含む）', () => {
  const url = (q = '') => new URL(`http://localhost:4777/${q}`);
  const req = (addr, port = 1) => ({ socket: { remoteAddress: addr, remotePort: port } });

  it('?key= が一致すれば、どこからでも可', () => {
    assert.equal(auth.mayReceiveToken(req('192.168.1.5'), url(`?key=${TOKEN}`), TOKEN, { serverPort: 4777 }), true);
  });
  it('?key= が違い、接続元が非ループバックなら不可', () => {
    assert.equal(auth.mayReceiveToken(req('192.168.1.5'), url('?key=zzz'), TOKEN, { serverPort: 4777 }), false);
    assert.equal(auth.mayReceiveToken(req('192.168.1.5'), url(), TOKEN, { trustLoopback: true, serverPort: 4777 }), false);
  });
  it('ループバックでも、接続元の UID を確認できなければ不可（存在しないポート）', { skip: process.platform !== 'linux' ? 'Linux のみ' : false }, () => {
    assert.equal(auth.mayReceiveToken(req('127.0.0.1', 1), url(), TOKEN, { serverPort: 1 }), false);
  });
  it('trustLoopback なら、ループバックなら UID を見ずに可', () => {
    assert.equal(auth.mayReceiveToken(req('127.0.0.1', 1), url(), TOKEN, { trustLoopback: true, serverPort: 4777 }), true);
    assert.equal(auth.mayReceiveToken(req('::1', 1), url(), TOKEN, { trustLoopback: true }), true);
    assert.equal(auth.mayReceiveToken(req('::ffff:127.0.0.1', 1), url(), TOKEN, { trustLoopback: true }), true);
  });
  it('strict なら、ループバックでも ?key= が無ければ不可（trustLoopback より優先）', () => {
    assert.equal(auth.mayReceiveToken(req('127.0.0.1'), url(), TOKEN, { strict: true, trustLoopback: true, serverPort: 4777 }), false);
    assert.equal(auth.mayReceiveToken(req('127.0.0.1'), url(`?key=${TOKEN}`), TOKEN, { strict: true, serverPort: 4777 }), true);
  });
});

describe('isLoopbackAddress', () => {
  it('ループバックのアドレスだけ true', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(auth.isLoopbackAddress(a), true, a);
    for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '', undefined]) assert.equal(auth.isLoopbackAddress(a), false, String(a));
  });
});

describe('peerUid（Linux の /proc/net/tcp で接続元の UID を確認）', { skip: process.platform !== 'linux' ? 'Linux のみ' : false }, () => {
  let server;
  let port;
  const sockets = [];

  before(async () => {
    server = net.createServer((s) => sockets.push(s));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });

  it('自分の接続なら、自分の UID を返す', async () => {
    const client = net.connect(port, '127.0.0.1');
    sockets.push(client);
    await new Promise((r) => client.once('connect', r));
    assert.equal(auth.peerUid(client.localPort, port), process.getuid());
  });

  it('ループバック接続の実物を渡すと、mayReceiveToken が true になる', async () => {
    const client = net.connect(port, '127.0.0.1');
    sockets.push(client);
    await new Promise((r) => client.once('connect', r));
    const req = { socket: { remoteAddress: '127.0.0.1', remotePort: client.localPort } };
    assert.equal(auth.mayReceiveToken(req, new URL('http://localhost/'), TOKEN, { serverPort: port }), true);
  });

  it('対応する接続が無い、または引数が整数でなければ null', () => {
    assert.equal(auth.peerUid(1, 2), null);
    assert.equal(auth.peerUid('x', port), null);
  });
});
