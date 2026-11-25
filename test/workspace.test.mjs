// ワークスペース画面の結合テスト。実サーバーを子プロセスで起動し、HTTP で確かめる。
// 端末は実 tmux（専用ソケット agent-viz-<テストポート>）を使い、mode は "shell" だけ。claude は起動しない。
// 終了時は、そのテストサーバーのソケットだけを kill-server する（一時 HOME の TMPDIR 配下にできる）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { request, postJson, openAsk, setPresence, startServer, stopServer, waitFor, registerSession } from './helpers.mjs';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** テストサーバーの tmux ソケットだけを終わらせる（TMPDIR は子サーバーと同じ一時 HOME） */
function killTmux(srv) {
  spawnSync('tmux', ['-L', `agent-viz-${srv.port}`, 'kill-server'], { env: { PATH: process.env.PATH, TMPDIR: srv.home } });
}
function tmuxIn(srv, args) {
  return spawnSync('tmux', ['-L', `agent-viz-${srv.port}`, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: srv.home } });
}

/** SSE を読む。events は { event, data } の配列（data は文字列のまま）。 */
function openSse(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const ctl = { status: res.statusCode, events: [], close: () => req.destroy() };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (event !== 'message' || data.length) ctl.events.push({ event, data: data.join('\n') });
        }
      });
      res.on('error', () => {});
      resolve(ctl);
    });
    req.on('error', reject);
  });
}

/** SSE の message（端末の出力）をつなげて UTF-8 文字列にする */
const outputOf = (ctl) => Buffer.concat(ctl.events.filter((e) => e.event === 'message').map((e) => Buffer.from(e.data, 'base64'))).toString('utf8');

// ---------------------------------------------------------------------------
describe('ワークスペース: 認証と検証（端末 API）', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { killTmux(srv); await stopServer(srv); });

  it('トークン無しの GET /api/term は 401', async () => {
    const r = await request(srv.port, { path: '/api/term' });
    assert.equal(r.status, 401);
  });

  it('トークン無しの stream は 401', async () => {
    const r = await request(srv.port, { path: '/api/term/stream?name=av-00000000' });
    assert.equal(r.status, 401);
  });

  it('POST は ?key= では 401（書き込みはヘッダのトークンだけ）', async () => {
    const r = await request(srv.port, {
      method: 'POST', path: `/api/term/create?key=${srv.token}`,
      headers: { 'content-type': 'application/json' }, body: { cwd: os.tmpdir(), mode: 'shell' },
    });
    assert.equal(r.status, 401);
    const k = await request(srv.port, {
      method: 'POST', path: `/api/term/kill?key=${srv.token}`,
      headers: { 'content-type': 'application/json' }, body: { name: 'av-00000000' },
    });
    assert.equal(k.status, 401);
  });

  it('Host が不正なら 403（トークンが正しくても）', async () => {
    const r = await request(srv.port, { path: '/api/term', host: '127.0.0.1', headers: { 'x-agent-viz-token': srv.token, host: 'evil.com:' + srv.port } });
    assert.equal(r.status, 403);
  });

  it('GET /api/term は ?key= で読める。形は available / socket / modes / terms', async () => {
    const r = await request(srv.port, { path: `/api/term?key=${srv.token}` });
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(typeof b.available, 'boolean');
    assert.equal(b.socket, `agent-viz-${srv.port}`);
    assert.deepEqual(b.modes, ['claude', 'continue', 'shell']);
    assert.ok(Array.isArray(b.terms));
  });

  it('不正な mode は 400', async () => {
    const r = await postJson(srv.port, '/api/term/create', { cwd: os.tmpdir(), mode: 'rm -rf /' }, { token: srv.token });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /invalid mode/);
  });

  it('相対パス・存在しない cwd は 400', async () => {
    const rel = await postJson(srv.port, '/api/term/create', { cwd: 'relative', mode: 'shell' }, { token: srv.token });
    assert.equal(rel.status, 400);
    const none = await postJson(srv.port, '/api/term/create', { cwd: path.join(os.tmpdir(), 'no-such-dir-agent-viz'), mode: 'shell' }, { token: srv.token });
    assert.equal(none.status, 400);
  });

  it('JSON でない本文・配列の本文は 400', async () => {
    const bad = await postJson(srv.port, '/api/term/create', '{not json', { token: srv.token });
    assert.equal(bad.status, 400);
    const arr = await postJson(srv.port, '/api/term/create', [1, 2], { token: srv.token });
    assert.equal(arr.status, 400);
  });

  it('存在しない id への input・resize は 404、不正な名前の stream は 400', async () => {
    const i = await postJson(srv.port, '/api/term/input', { id: 'nope', data: b64('x') }, { token: srv.token });
    assert.equal(i.status, 404);
    const z = await postJson(srv.port, '/api/term/resize', { id: 'nope', cols: 80, rows: 24 }, { token: srv.token });
    assert.equal(z.status, 404);
    const s = await request(srv.port, { path: '/api/term/stream?name=bad', headers: { 'x-agent-viz-token': srv.token } });
    assert.equal(s.status, 400);
  });
});

// ---------------------------------------------------------------------------
describe('ワークスペース: 端末の一連の操作（実 tmux）', { skip: !hasTmux && 'tmux が無いのでskip' }, () => {
  let srv;
  let cwd;
  before(async () => {
    // 利用者の rc を読まない固定のシェルにする
    srv = await startServer({ env: { SHELL: '/bin/sh' } });
    cwd = tmpDir('agent-viz-ws-');
  });
  after(async () => { killTmux(srv); await stopServer(srv); fs.rmSync(cwd, { recursive: true, force: true }); });

  it('create → list → stream(attached と出力) → input → resize → kill → exit', async () => {
    const c = await postJson(srv.port, '/api/term/create', { cwd, mode: 'shell' }, { token: srv.token });
    assert.equal(c.status, 200);
    const { name } = JSON.parse(c.body);
    assert.match(name, /^av-[0-9a-f]{8}$/);

    const list = JSON.parse((await request(srv.port, { path: '/api/term', headers: { 'x-agent-viz-token': srv.token } })).body);
    const t = list.terms.find((x) => x.name === name);
    assert.ok(t, '一覧に出る');
    assert.equal(t.cwd, cwd);

    const sse = await openSse(srv.port, `/api/term/stream?name=${name}&cols=90&rows=20`, { 'x-agent-viz-token': srv.token });
    try {
      assert.equal(sse.status, 200);
      const attached = await waitFor(() => sse.events.find((e) => e.event === 'attached'), { timeout: 5000 });
      assert.ok(attached, 'attached が届く');
      const { id } = JSON.parse(attached.data);
      assert.match(id, /^[0-9a-f]{24}$/);

      // 最初の画面（出力）が届いてから入力する（届く前の入力は捨てられるため）
      assert.ok(await waitFor(() => outputOf(sse).length > 0, { timeout: 5000 }), '画面の出力が届く');

      const inp = await postJson(srv.port, '/api/term/input', { id, data: b64('printf "ws-%s\\n" 日本語\n') }, { token: srv.token });
      assert.equal(inp.status, 204);
      assert.ok(await waitFor(() => outputOf(sse).includes('ws-日本語'), { timeout: 8000 }), '日本語の入出力が通る');

      const rs = await postJson(srv.port, '/api/term/resize', { id, cols: 120, rows: 40 }, { token: srv.token });
      assert.equal(rs.status, 204);
      const sized = await waitFor(() => tmuxIn(srv, ['display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}']).stdout.trim() === '120x40', { timeout: 3000 });
      assert.ok(sized, 'resize が端末に反映される');

      const k = await postJson(srv.port, '/api/term/kill', { name }, { token: srv.token });
      assert.equal(k.status, 200);
      assert.ok(await waitFor(() => sse.events.some((e) => e.event === 'exit'), { timeout: 5000 }), 'exit が届く');

      const again = await postJson(srv.port, '/api/term/kill', { name }, { token: srv.token });
      assert.equal(again.status, 404, '既に無い端末の kill は 404');
    } finally {
      sse.close();
    }
  });

  it('存在しない端末への stream は attached のあと exit で閉じる', async () => {
    const sse = await openSse(srv.port, '/api/term/stream?name=av-ffffffff', { 'x-agent-viz-token': srv.token });
    try {
      assert.ok(await waitFor(() => sse.events.some((e) => e.event === 'exit'), { timeout: 5000 }), 'exit が届く');
      assert.equal(sse.events[0].event, 'attached');
    } finally { sse.close(); }
  });
});

// ---------------------------------------------------------------------------
describe('ワークスペース: AGENT_VIZ_TERMINAL=0 で端末を無効化', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { AGENT_VIZ_TERMINAL: '0' } }); });
  after(() => stopServer(srv));

  it('端末の API（一覧・作成・stream・入力）は 403', async () => {
    const h = { 'x-agent-viz-token': srv.token };
    assert.equal((await request(srv.port, { path: '/api/term', headers: h })).status, 403);
    assert.equal((await postJson(srv.port, '/api/term/create', { cwd: os.tmpdir(), mode: 'shell' }, { token: srv.token })).status, 403);
    assert.equal((await request(srv.port, { path: '/api/term/stream?name=av-00000000', headers: h })).status, 403);
    assert.equal((await postJson(srv.port, '/api/term/input', { id: 'x', data: '' }, { token: srv.token })).status, 403);
  });
});

// ---------------------------------------------------------------------------
describe('ワークスペース: /api/file（プレビュー）', () => {
  let srv;
  let dir;
  let sid;
  const big = () => path.join(dir, 'big.png');
  before(async () => {
    srv = await startServer();
    dir = tmpDir('agent-viz-file-');
    fs.writeFileSync(path.join(dir, 'shot.png'), 'PNG-日本語-data');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# 見出し\n本文');
    fs.writeFileSync(path.join(dir, 'other.png'), 'not recorded');
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"secret":"SECRET-VALUE"}');
    fs.symlinkSync(path.join(dir, 'secret.json'), path.join(dir, 'link.png'));
    fs.writeFileSync(big(), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

    sid = `ws-file-${process.pid}`;
    assert.equal((await registerSession(srv.port, sid, dir)).status, 204);
    // hook が送る形（file は絶対パス）。対象拡張子だけ記録される
    for (const f of ['shot.png', 'notes.md', 'link.png', 'big.png']) {
      const r = await postJson(srv.port, '/event', { event: 'PostToolUse', session_id: sid, cwd: dir, t: Date.now(), tool_name: 'Write', file: path.join(dir, f) });
      assert.equal(r.status, 204);
    }
    // 対象外の拡張子は記録されない（送られてきても）
    await postJson(srv.port, '/event', { event: 'PostToolUse', session_id: sid, cwd: dir, t: Date.now(), tool_name: 'Write', file: path.join(dir, 'secret.json') });
  });
  after(async () => {
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (file, opts = {}) => request(srv.port, {
    path: `/api/file?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(file)}`,
    headers: opts.token ? { 'x-agent-viz-token': opts.token } : {},
  });

  it('記録済みの画像は、その型と中身で返る（nosniff と sandbox を付ける）', async () => {
    const r = await get(path.join(dir, 'shot.png'), { token: srv.token });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.body, 'PNG-日本語-data');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  });

  it('記録済みの Markdown は text/plain で返る', async () => {
    const r = await get(path.join(dir, 'notes.md'), { token: srv.token });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/plain/);
    assert.equal(r.body, '# 見出し\n本文');
  });

  it('トークン無しは 401。?key= なら読める', async () => {
    assert.equal((await get(path.join(dir, 'shot.png'))).status, 401);
    const r = await request(srv.port, {
      path: `/api/file?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(path.join(dir, 'shot.png'))}&key=${srv.token}`,
    });
    assert.equal(r.status, 200);
  });

  it('未記録のファイル（存在しても）は 404', async () => {
    assert.equal((await get(path.join(dir, 'other.png'), { token: srv.token })).status, 404);
  });

  it('記録されていないセッション・相対パスは 404', async () => {
    const unknown = await request(srv.port, {
      path: `/api/file?session=nope&path=${encodeURIComponent(path.join(dir, 'shot.png'))}`, headers: { 'x-agent-viz-token': srv.token },
    });
    assert.equal(unknown.status, 404);
    const rel = await request(srv.port, {
      path: `/api/file?session=${encodeURIComponent(sid)}&path=shot.png`, headers: { 'x-agent-viz-token': srv.token },
    });
    assert.equal(rel.status, 404);
  });

  it('記録済みでも、リンク先が対象外の拡張子なら 404（中身も出さない）', async () => {
    const r = await get(path.join(dir, 'link.png'), { token: srv.token });
    assert.equal(r.status, 404);
    assert.equal(r.body.includes('SECRET-VALUE'), false);
  });

  it('対象外の拡張子（json）は、記録されていなくても 404', async () => {
    const r = await get(path.join(dir, 'secret.json'), { token: srv.token });
    assert.equal(r.status, 404);
  });

  it('10MB を超えるファイルは 413', async () => {
    const r = await get(big(), { token: srv.token });
    assert.equal(r.status, 413);
  });
});

// ---------------------------------------------------------------------------
describe('ワークスペース: 読み手への /api/state（AGENT_VIZ_STRICT_KEY=1）', () => {
  let srv;
  const term = 'av-0123abcd';
  const sid = `ws-state-${process.pid}`;
  before(async () => {
    srv = await startServer({ env: { AGENT_VIZ_STRICT_KEY: '1' } });
    await registerSession(srv.port, sid, '/home/user/project');
    await postJson(srv.port, '/event', {
      event: 'PreToolUse', session_id: sid, cwd: '/home/user/project', t: Date.now(), tool_name: 'Write', term, file: '/home/user/project/shot.png',
    });
  });
  after(() => stopServer(srv));

  it('トークン無しの読み手には term と files が出ない', async () => {
    const r = await request(srv.port, { path: '/api/state' });
    assert.equal(r.status, 200);
    assert.equal(r.body.includes(term), false, '端末名が出ない');
    assert.equal(r.body.includes('/home/user/project/shot.png'), false, 'ファイルのパスが出ない');
    const s = JSON.parse(r.body).sessions.find((x) => x.id === sid);
    assert.equal('term' in s, false);
    assert.deepEqual(s.files, []);
  });

  it('?key= で開いた画面には term と files が出る', async () => {
    const r = await request(srv.port, { path: `/api/state?key=${srv.token}` });
    const s = JSON.parse(r.body).sessions.find((x) => x.id === sid);
    assert.equal(s.term, term);
    assert.equal(s.files.length, 1);
    assert.equal(s.files[0].path, '/home/user/project/shot.png');
  });
});

// ---------------------------------------------------------------------------
describe('ワークスペース: 静的な配信とヘッダ', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => stopServer(srv));

  it('/vendor の許可リスト（xterm.js・xterm.css・addon-fit.js）は配る。他は 404', async () => {
    const js = await request(srv.port, { path: '/vendor/xterm.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal((await request(srv.port, { path: '/vendor/xterm.css' })).status, 200);
    assert.equal((await request(srv.port, { path: '/vendor/addon-fit.js' })).status, 200);
    assert.equal((await request(srv.port, { path: '/vendor/LICENSE.xterm' })).status, 404);
    assert.equal((await request(srv.port, { path: '/vendor/README.txt' })).status, 404);
    assert.equal((await request(srv.port, { path: '/vendor/nope.js' })).status, 404);
    assert.equal((await request(srv.port, { path: '/vendor/..%2fserver.mjs' })).status, 404);
  });

  it('/workspace は iframe に埋め込めない（frame-ancestors none / DENY）', async () => {
    const r = await request(srv.port, { path: '/workspace' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
  });

  it('/ も iframe に埋め込めない（frame-ancestors none / DENY）', async () => {
    const r = await request(srv.port, { path: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
  });
});

describe('端末のセッションの ask', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => stopServer(srv));

  it('許可と質問は待たずに 204（端末に出す）。followup は待つ', async () => {
    await postJson(srv.port, '/event', { event: 'UserPromptSubmit', session_id: 'term-s', t: Date.now(), term: 'av-0123abcd' });
    await setPresence(srv.port, srv.token, true, 'c1');
    for (const kind of ['permission', 'question']) {
      const r = await openAsk(srv.port, { kind, session_id: 'term-s', payload: {}, wait_ms: 5000 }, { token: srv.token }).promise;
      assert.equal(r.status, 204, kind);
    }
    await postJson(srv.port, '/api/settings', { followup: { session_id: 'term-s', enabled: true } }, { token: srv.token });
    const f = openAsk(srv.port, { kind: 'followup', session_id: 'term-s', payload: {}, wait_ms: 1000 }, { token: srv.token });
    const t0 = Date.now();
    await f.promise;
    assert.ok(Date.now() - t0 >= 800, 'followup は待つ');
  });
});

describe('ディレクトリの補完', () => {
  it('前方一致するディレクトリだけを返し、~ と隠しディレクトリを扱う', async () => {
    const { listDirs, expandHome } = await import('../server/workspace.mjs');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-dirs-'));
    try {
      for (const d of ['alpha', 'alps', 'Beta', '.hidden']) fs.mkdirSync(path.join(home, d));
      fs.writeFileSync(path.join(home, 'alfile'), '');
      assert.deepEqual(listDirs('~/al', home), ['~/alpha/', '~/alps/']);
      assert.deepEqual(listDirs(`${home}/be`, home), [`${home}/Beta/`]);
      assert.ok(!listDirs('~/', home).includes('~/.hidden/'));
      assert.deepEqual(listDirs('~/.h', home), ['~/.hidden/']);
      assert.deepEqual(listDirs('relative', home), []);
      assert.deepEqual(listDirs('/no/such/dir/x', home), []);
      assert.equal(expandHome('~/a', home), `${home}/a`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
