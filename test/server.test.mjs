// server/server.mjs の結合テスト。実際にサーバーを子プロセスで起動し、HTTP で確かめる。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getState, lanIPv4, openAsk, postJson, registerSession, request, setPresence, startServer, stopServer, waitFor, waitForAsk,
} from './helpers.mjs';

const CLIENT = 'test-browser';
// index.html の script にもこの名前が出てくるので、meta タグの有無で判定する
const hasMeta = (body) => /<meta name="agent-viz-token" content="/.test(body);
let counter = 0;
const newSid = () => `sess-${process.pid}-${++counter}`;
const permPayload = (over = {}) => ({ tool_name: 'Bash', summary: 'ls -la', input_preview: '{"command":"ls -la"}', ...over });
const askQuestion = () => ({
  questions: [
    { question: 'どの方式にしますか？', header: '方式', multiSelect: false, options: [{ label: 'A案', description: '速い' }, { label: 'B案', description: '丁寧' }] },
    { question: '対象は？', header: '対象', multiSelect: true, options: [{ label: 'x', description: '' }, { label: 'z', description: '' }] },
  ],
});

async function present(srv, visible = true) {
  const r = await setPresence(srv.port, srv.token, visible, CLIENT);
  assert.equal(r.status, 204);
}

async function newSession(srv) {
  const sid = newSid();
  const r = await registerSession(srv.port, sid);
  assert.equal(r.status, 204);
  return sid;
}

async function asksOf(srv, sid, opts = {}) {
  const st = await getState(srv.port, opts);
  return st.sessions.find((s) => s.id === sid)?.asks ?? [];
}

function answer(srv, id, body) {
  return postJson(srv.port, '/api/answer', { id, answer: body }, { token: srv.token });
}

// ---------------------------------------------------------------------------
describe('サーバー: 認証と検証', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => stopServer(srv));

  it('トークン無しの /api/ask は 401', async () => {
    const sid = await newSession(srv);
    const r = await postJson(srv.port, '/api/ask', { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 1000 });
    assert.equal(r.status, 401);
  });

  it('トークンが違う書き込みも 401', async () => {
    const r = await postJson(srv.port, '/api/presence', { client: CLIENT, visible: true }, { token: 'b'.repeat(48) });
    assert.equal(r.status, 401);
  });

  it('Host が許可外なら 403（DNS リバインディング対策。トークンが正しくても）', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { host: 'evil.com:' + srv.port } });
    assert.equal(r.status, 403);
    const w = await postJson(srv.port, '/api/presence', { client: CLIENT, visible: true }, { token: srv.token, headers: { host: 'evil.com:' + srv.port } });
    assert.equal(w.status, 403);
  });

  it('Origin が他サイトなら 403', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { origin: 'http://evil.com' } });
    assert.equal(r.status, 403);
  });

  it('他サイトからの fetch（sec-fetch-site: cross-site / mode: cors）は 403。書き込みもトークンより先に 403', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
    assert.equal(r.status, 403);
    const w = await request(srv.port, {
      method: 'POST', path: '/api/ask',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'x-agent-viz-token': srv.token },
      body: '{}',
    });
    assert.equal(w.status, 403);
  });

  it('同一オリジンの fetch（same-origin）は通る', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } });
    assert.equal(r.status, 200);
  });

  it('/event は application/json 以外（text/plain）なら 415', async () => {
    const r = await request(srv.port, {
      method: 'POST', path: '/event', headers: { 'content-type': 'text/plain' }, body: '{"event":"SessionStart","session_id":"x"}',
    });
    assert.equal(r.status, 415);
  });

  it('/event は JSON なら、トークン無しでも受け付ける（既存の hook 互換）', async () => {
    const sid = newSid();
    const r = await registerSession(srv.port, sid);
    assert.equal(r.status, 204);
    const st = await getState(srv.port);
    assert.ok(st.sessions.some((s) => s.id === sid));
  });

  it('/api/state にトークンは含まれず、settings は answerEnabled と watching を持つ', async () => {
    const r = await request(srv.port, { path: '/api/state' });
    assert.equal(r.status, 200);
    assert.equal(r.body.includes(srv.token), false);
    const st = JSON.parse(r.body);
    assert.equal(st.settings.answerEnabled, true);
    assert.equal(typeof st.settings.watching, 'boolean');
  });
});

// ---------------------------------------------------------------------------
describe('サーバー: 待ち合わせ（ask / answer）', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => stopServer(srv));

  it('盤面が見えていない（presence が無い・visible: false）なら、待たずに 204', async () => {
    const sid = await newSession(srv);
    await present(srv, false);
    const t0 = Date.now();
    const r = await openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token }).promise;
    assert.equal(r.status, 204);
    assert.ok(Date.now() - t0 < 2000, 'should not wait');
    assert.deepEqual(await asksOf(srv, sid), []);
  });

  it('盤面に出ていないセッションの ask は、見えていても待たずに 204', async () => {
    await present(srv);
    const t0 = Date.now();
    const r = await openAsk(srv.port, { kind: 'permission', session_id: 'never-registered', payload: permPayload(), wait_ms: 10000 }, { token: srv.token }).promise;
    assert.equal(r.status, 204);
    assert.ok(Date.now() - t0 < 2000, 'should not wait');
  });

  it('許可: 盤面で allow すると、hook 側に 200 {answer} で返る', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'permission');
    assert.ok(ask, 'ask が盤面に出ない');
    assert.equal(ask.payload.tool_name, 'Bash');
    const ok = await answer(srv, ask.id, { behavior: 'allow' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    const res = await call.promise;
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"answer":{"behavior":"allow"}}');
  });

  it('拒否: message 付きの deny がそのまま返る', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'permission');
    await answer(srv, ask.id, { behavior: 'deny', message: 'やめて' });
    const res = await call.promise;
    assert.deepEqual(JSON.parse(res.body), { answer: { behavior: 'deny', message: 'やめて' } });
  });

  it('端末で判断（skip）は {skip:true} で返る', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'permission');
    await answer(srv, ask.id, { skip: true });
    const res = await call.promise;
    assert.equal(res.body, '{"answer":{"skip":true}}');
  });

  it('質問: 全問の回答が answers として返る', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'question', session_id: sid, payload: askQuestion(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'question');
    assert.equal(ask.payload.questions.length, 2);
    const answers = { 'どの方式にしますか？': 'B案', '対象は？': 'x, z' };
    assert.equal((await answer(srv, ask.id, { answers })).status, 200);
    const res = await call.promise;
    assert.deepEqual(JSON.parse(res.body), { answer: { answers } });
  });

  it('同じ ask への二重回答は 404。存在しない id も 404', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'permission');
    assert.equal((await answer(srv, ask.id, { behavior: 'allow' })).status, 200);
    assert.equal((await answer(srv, ask.id, { behavior: 'deny' })).status, 404);
    assert.equal((await answer(srv, '0'.repeat(24), { behavior: 'allow' })).status, 404);
    await call.promise;
  });

  it('不正な回答は 404 で、ask は残る（正しい回答で受理される）', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'permission');
    assert.equal((await answer(srv, ask.id, { behavior: 'maybe' })).status, 404);
    assert.equal((await asksOf(srv, sid)).length, 1);
    assert.equal((await answer(srv, ask.id, { behavior: 'allow' })).status, 200);
    assert.equal((await call.promise).body, '{"answer":{"behavior":"allow"}}');
  });

  it('回答の id が無い・文字列でなければ 400', async () => {
    const r = await postJson(srv.port, '/api/answer', { answer: { behavior: 'allow' } }, { token: srv.token });
    assert.equal(r.status, 400);
    const r2 = await postJson(srv.port, '/api/answer', { id: 42, answer: { behavior: 'allow' } }, { token: srv.token });
    assert.equal(r2.status, 400);
  });

  it('/api/ask の入力が不正なら 400（kind・session_id・payload・wait_ms）', async () => {
    const sid = await newSession(srv);
    const bodies = [
      { kind: 'bogus', session_id: sid, payload: {}, wait_ms: 1000 },
      { kind: 'permission', payload: {}, wait_ms: 1000 },
      { kind: 'permission', session_id: sid, payload: [], wait_ms: 1000 },
      { kind: 'permission', session_id: sid, payload: {}, wait_ms: 'soon' },
    ];
    for (const b of bodies) {
      const r = await postJson(srv.port, '/api/ask', b, { token: srv.token });
      assert.equal(r.status, 400, JSON.stringify(b));
    }
  });

  it('JSON が壊れている・オブジェクトでない本文は 400', async () => {
    const broken = await postJson(srv.port, '/api/ask', '{not json', { token: srv.token });
    assert.equal(broken.status, 400);
    const arr = await postJson(srv.port, '/api/ask', '[1,2]', { token: srv.token });
    assert.equal(arr.status, 400);
    const ans = await postJson(srv.port, '/api/answer', 'nope', { token: srv.token });
    assert.equal(ans.status, 400);
  });

  it('本文が 64KB を超えたら 413', async () => {
    const r = await request(srv.port, {
      method: 'POST', path: '/api/ask',
      headers: { 'content-type': 'application/json', 'x-agent-viz-token': srv.token },
      body: 'x'.repeat(70 * 1024),
    });
    assert.equal(r.status, 413);
  });

  it('待ち時間が過ぎると 204 を返し、盤面からも消える', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const t0 = Date.now();
    const r = await openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 1000 }, { token: srv.token }).promise;
    assert.equal(r.status, 204);
    assert.ok(Date.now() - t0 >= 900, 'returned too early');
    assert.deepEqual(await asksOf(srv, sid), []);
  });

  it('ask 側が切断すると、盤面から取り下げられる', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    await waitForAsk(srv.port, sid, 'permission');
    call.abort();
    const gone = await waitFor(async () => (await asksOf(srv, sid)).length === 0, { timeout: 3000 });
    assert.ok(gone, 'ask が取り下げられていない');
  });

  it('未処理の ask が 50 件を超えると 429。セッション終了で全部取り下げられる', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const calls = [];
    for (let i = 0; i < 50; i++) {
      calls.push(openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 20000 }, { token: srv.token }));
    }
    const full = await waitFor(async () => (await asksOf(srv, sid)).length === 50, { timeout: 8000 });
    assert.ok(full, '50 件が盤面に出ない');
    const over = await openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 20000 }, { token: srv.token }).promise;
    assert.equal(over.status, 429);
    await postJson(srv.port, '/event', { event: 'SessionEnd', session_id: sid, t: Date.now() });
    const results = await Promise.all(calls.map((c) => c.promise));
    assert.ok(results.every((r) => r.status === 204));
  });

  it('SessionEnd で待っている ask が取り下げられる（204）', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    await waitForAsk(srv.port, sid, 'permission');
    await postJson(srv.port, '/event', { event: 'SessionEnd', session_id: sid, t: Date.now() });
    assert.equal((await call.promise).status, 204);
  });

  it('待機モード（followup）: オフのセッションは 204、オンにすると次の指示を待ち、テキストが返る', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const off = await openAsk(srv.port, { kind: 'followup', session_id: sid, payload: { last_message: '完了' }, wait_ms: 1000 }, { token: srv.token }).promise;
    assert.equal(off.status, 204);

    const on = await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: true } }, { token: srv.token });
    assert.equal(on.status, 204);
    const st = await getState(srv.port);
    assert.equal(st.sessions.find((s) => s.id === sid).followup, true);

    const call = openAsk(srv.port, { kind: 'followup', session_id: sid, payload: { last_message: '完了' }, wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'followup');
    assert.equal((await answer(srv, ask.id, { text: '次に進めて' })).status, 200);
    assert.equal((await call.promise).body, '{"answer":{"text":"次に進めて"}}');
  });

  it('followup の空のテキストは 404（不正な回答）。待機モードをオフにすると 204 で取り下げ', async () => {
    await present(srv);
    const sid = await newSession(srv);
    await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: true } }, { token: srv.token });
    const call = openAsk(srv.port, { kind: 'followup', session_id: sid, payload: { last_message: '完了' }, wait_ms: 10000 }, { token: srv.token });
    const ask = await waitForAsk(srv.port, sid, 'followup');
    assert.equal((await answer(srv, ask.id, { text: '   ' })).status, 404);
    const off = await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: false } }, { token: srv.token });
    assert.equal(off.status, 204);
    assert.equal((await call.promise).status, 204);
  });

  it('「盤面で回答する」をオフにすると、待っている ask は取り下げられ、新しい ask は 204', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    await waitForAsk(srv.port, sid, 'permission');
    try {
      const off = await postJson(srv.port, '/api/settings', { answerEnabled: false }, { token: srv.token });
      assert.equal(off.status, 204);
      assert.equal((await call.promise).status, 204);
      const st = await getState(srv.port);
      assert.equal(st.settings.answerEnabled, false);
      const next = await openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token }).promise;
      assert.equal(next.status, 204);
    } finally {
      await postJson(srv.port, '/api/settings', { answerEnabled: true }, { token: srv.token });
    }
  });

  it('settings が不正（空・知らないキー・型違い）なら 400', async () => {
    const empty = await postJson(srv.port, '/api/settings', { foo: 1 }, { token: srv.token });
    assert.equal(empty.status, 400);
    const type = await postJson(srv.port, '/api/settings', { answerEnabled: 'yes' }, { token: srv.token });
    assert.equal(type.status, 400);
    const fu = await postJson(srv.port, '/api/settings', { followup: { session_id: 'x' } }, { token: srv.token });
    assert.equal(fu.status, 400);
  });

  it('presence の visible が真偽値でなければ 400', async () => {
    const r = await postJson(srv.port, '/api/presence', { client: CLIENT, visible: 'yes' }, { token: srv.token });
    assert.equal(r.status, 400);
  });

  it('/api/clear: トークンが無いと 401。あると待っている ask を取り下げる', async () => {
    await present(srv);
    const sid = await newSession(srv);
    const call = openAsk(srv.port, { kind: 'permission', session_id: sid, payload: permPayload(), wait_ms: 10000 }, { token: srv.token });
    await waitForAsk(srv.port, sid, 'permission');
    const no = await request(srv.port, { method: 'POST', path: '/api/clear', headers: { 'content-type': 'application/json' } });
    assert.equal(no.status, 401);
    const yes = await postJson(srv.port, '/api/clear', {}, { token: srv.token });
    assert.equal(yes.status, 204);
    assert.equal((await call.promise).status, 204);
  });
});

// ---------------------------------------------------------------------------
describe('サーバー: GET / と埋め込み', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => stopServer(srv));

  it('ループバックからの GET / には、token を meta で </head> の直前に入れる', async () => {
    const r = await request(srv.port, { path: '/' });
    assert.equal(r.status, 200);
    const meta = `<meta name="agent-viz-token" content="${srv.token}">`;
    assert.ok(r.body.includes(`${meta}</head>`), 'meta が </head> の直前に無い');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('GET / は iframe 埋め込みを禁止するヘッダを付ける', async () => {
    const r = await request(srv.port, { path: '/' });
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
  });

  it('ループバックなら ?key= が違っても meta は入る（既定の動作）', async () => {
    const r = await request(srv.port, { path: '/?key=' + 'c'.repeat(48) });
    assert.equal(hasMeta(r.body), true);
  });

  it('他サイトからのトップレベル移動（navigate・document）は GET / を 200 で返す', async () => {
    const r = await request(srv.port, {
      path: '/',
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    assert.equal(r.status, 200);
  });

  it('他サイトからの navigate でも、書き込み（POST）は 403', async () => {
    const r = await request(srv.port, {
      method: 'POST', path: '/api/presence',
      headers: {
        'content-type': 'application/json', 'x-agent-viz-token': srv.token,
        'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
      },
      body: JSON.stringify({ client: CLIENT, visible: true }),
    });
    assert.equal(r.status, 403);
  });
});

// ---------------------------------------------------------------------------
describe('サーバー: AGENT_VIZ_STRICT_KEY=1（複数ユーザーのマシン向け）', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { AGENT_VIZ_STRICT_KEY: '1' } }); });
  after(() => stopServer(srv));

  const metaOf = (t) => `<meta name="agent-viz-token" content="${t}">`;

  it('?key= が無ければ、ループバックからでも token を渡さない', async () => {
    const r = await request(srv.port, { path: '/' });
    assert.equal(r.status, 200);
    assert.equal(hasMeta(r.body), false);
  });

  it('?key= が違えば渡さない', async () => {
    const r = await request(srv.port, { path: '/?key=' + 'd'.repeat(48) });
    assert.equal(hasMeta(r.body), false);
  });

  it('?key= が一致すれば渡す', async () => {
    const r = await request(srv.port, { path: `/?key=${srv.token}` });
    assert.ok(r.body.includes(metaOf(srv.token)));
  });

  it('strict でも、API は token ヘッダで普通に使える', async () => {
    const r = await setPresence(srv.port, srv.token, true, CLIENT);
    assert.equal(r.status, 204);
  });
});

// ---------------------------------------------------------------------------
describe('サーバー: AGENT_VIZ_ALLOWED_HOSTS', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: (port) => ({ AGENT_VIZ_ALLOWED_HOSTS: `myhost.test:${port}` }) });
  });
  after(() => stopServer(srv));

  it('追加した Host（myhost.test:PORT）は許可される（大文字小文字は問わない）', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { host: `myhost.test:${srv.port}` } });
    assert.equal(r.status, 200);
    const r2 = await request(srv.port, { path: '/api/state', headers: { host: `MyHost.TEST:${srv.port}` } });
    assert.equal(r2.status, 200);
  });

  it('追加していない Host は引き続き 403。localhost は通る', async () => {
    const other = await request(srv.port, { path: '/api/state', headers: { host: `other.test:${srv.port}` } });
    assert.equal(other.status, 403);
    const local = await request(srv.port, { path: '/api/state' });
    assert.equal(local.status, 200);
  });

  it('追加した Origin と Host の組み合わせは、書き込み（presence）も通る', async () => {
    const r = await postJson(srv.port, '/api/presence', { client: CLIENT, visible: true }, {
      token: srv.token, headers: { host: `myhost.test:${srv.port}`, origin: `http://myhost.test:${srv.port}` },
    });
    assert.equal(r.status, 204);
  });
});

// ---------------------------------------------------------------------------
describe('サーバー: AGENT_VIZ_HOST=0.0.0.0', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { AGENT_VIZ_HOST: '0.0.0.0' } }); });
  after(() => stopServer(srv));

  it('ループバックの Host（localhost / 127.0.0.1）は通る', async () => {
    assert.equal((await request(srv.port, { path: '/api/state', headers: { host: `localhost:${srv.port}` } })).status, 200);
    assert.equal((await request(srv.port, { path: '/api/state', headers: { host: `127.0.0.1:${srv.port}` } })).status, 200);
  });

  it('Host に 0.0.0.0 を書いても許可されない（具体的なホストではないので自動追加しない）', async () => {
    const r = await request(srv.port, { path: '/api/state', headers: { host: `0.0.0.0:${srv.port}` } });
    assert.equal(r.status, 403);
  });
});

// ---------------------------------------------------------------------------
// 同じマシンの LAN 側の IP で待ち受けたときの確認。非ループバックの IP が無い環境では飛ばす。
const LAN = lanIPv4();
describe('サーバー: AGENT_VIZ_HOST に具体的な IP（非ループバック）', { skip: LAN ? false : 'non-loopback IPv4 address not found' }, () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { AGENT_VIZ_HOST: LAN }, probeHost: LAN });
  });
  after(() => stopServer(srv));

  it('HOST:PORT は自動で許可されるので、その Host の /api/state は 200', async () => {
    const r = await request(srv.port, { host: LAN, path: '/api/state', headers: { host: `${LAN}:${srv.port}` } });
    assert.equal(r.status, 200);
  });

  it('非ループバックからの GET / は、?key= が無ければ token を渡さない', async () => {
    const r = await request(srv.port, { host: LAN, path: '/', headers: { host: `${LAN}:${srv.port}` } });
    assert.equal(r.status, 200);
    assert.equal(hasMeta(r.body), false);
  });

  it('非ループバックでも ?key= が一致すれば token を渡す', async () => {
    const r = await request(srv.port, { host: LAN, path: `/?key=${srv.token}`, headers: { host: `${LAN}:${srv.port}` } });
    assert.ok(r.body.includes(`content="${srv.token}"`));
  });
});

describe('サーバー: AGENT_VIZ_HOST=0.0.0.0 と AGENT_VIZ_ALLOWED_HOSTS で LAN 側の Host を許可', { skip: LAN ? false : 'non-loopback IPv4 address not found' }, () => {
  let srv;
  before(async () => {
    srv = await startServer({
      env: (port) => ({ AGENT_VIZ_HOST: '0.0.0.0', AGENT_VIZ_ALLOWED_HOSTS: `${LAN}:${port}` }),
      probeHost: '127.0.0.1',
    });
  });
  after(() => stopServer(srv));

  it('追加した LAN の Host は許可、非ループバックの GET / は token を渡さない', async () => {
    const api = await request(srv.port, { host: LAN, path: '/api/state', headers: { host: `${LAN}:${srv.port}` } });
    assert.equal(api.status, 200);
    const page = await request(srv.port, { host: LAN, path: '/', headers: { host: `${LAN}:${srv.port}` } });
    assert.equal(hasMeta(page.body), false);
  });
});
