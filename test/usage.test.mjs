// 使用状況（POST /api/usage と、スナップショットの usage / sessions[].context）の結合テスト。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getState, postJson, request, sleep, startServer, stopServer, waitFor } from './helpers.mjs';

const NOW_SEC = Math.floor(Date.now() / 1000);
const RESET = NOW_SEC + 3600; // 利用枠のリセット時刻（epoch 秒）。受け付ける上限より手前にする
const HOUR = 3600;
const DAY = 24 * HOUR;
const T = Date.now();

let srv;
/** テストごとに新しいサーバーを使う（利用枠はサーバー全体で 1 つなので、持ち越さない） */
function freshServer(opts) {
  beforeEach(async () => { srv = await startServer(opts); });
  afterEach(() => stopServer(srv));
}

const addSession = async (sid, t = T) => {
  const r = await postJson(srv.port, '/event', { event: 'UserPromptSubmit', session_id: sid, t, cwd: '/home/user/project', prompt: 'p' });
  assert.equal(r.status, 204);
};
const post = async (body) => {
  const r = await postJson(srv.port, '/api/usage', body);
  assert.equal(r.status, 204, r.body);
};
const state = () => getState(srv.port);
const sessionOf = async (sid) => (await state()).sessions.find((s) => s.id === sid);
const contextOf = async (sid) => (await sessionOf(sid)).context;
const usageOf = async () => (await state()).usage;
const limit = (used, resets) => (resets === undefined ? { used_percentage: used } : { used_percentage: used, resets_at: resets });

const full = (sid) => ({
  session_id: sid,
  transcript_path: '/home/user/.claude/x.jsonl',
  model: { id: 'claude-x', display_name: 'Opus' },
  workspace: { current_dir: '/home/user/project' },
  cost: { total_cost_usd: 1.5 },
  context_window: {
    used_percentage: 42.5, total_input_tokens: 85000, context_window_size: 200000, total_output_tokens: 10,
    current_usage: { input_tokens: 1 },
  },
  rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: RESET, other: 'x' },
    seven_day: { used_percentage: 80, resets_at: RESET + 1000 },
    seven_day_opus: { used_percentage: 1, resets_at: RESET },
  },
});
const FULL_CONTEXT = { used_percentage: 42.5, tokens: 85000, window: 200000, model: 'Opus' };
const FULL_USAGE = { five_hour: limit(12.5, RESET), seven_day: limit(80, RESET + 1000) };

// ---------------------------------------------------------------------------
describe('使用状況: 受理と抽出', () => {
  freshServer();

  it('データが無ければ usage は null で、sessions[].context は付かない', async () => {
    await addSession('s1');
    const st = await state();
    assert.equal(st.usage, null);
    assert.equal('context' in st.sessions[0], false);
  });

  it('トークン無しで受け付けて 204。必要な項目だけを usage と sessions[].context に出す', async () => {
    await addSession('s1');
    await post(full('s1'));
    const st = await state();
    assert.deepEqual(st.usage, FULL_USAGE);
    assert.deepEqual(st.sessions[0].context, FULL_CONTEXT);
  });

  it('context_window も rate_limits も無い投稿は 204 で、何も付けない', async () => {
    await addSession('s1');
    await post({});
    await post({ session_id: 's1' });
    assert.equal(await usageOf(), null);
    assert.equal(await contextOf('s1'), undefined);
  });

  it('知らない session_id では、セッションを作らない。利用枠は採用する', async () => {
    await post(full('unknown'));
    const st = await state();
    assert.deepEqual(st.sessions, []);
    assert.deepEqual(st.usage, FULL_USAGE);
  });

  it('知らないセッションの投稿は、あとから同じ id のセッションができても context を付けない', async () => {
    await post(full('later'));
    await addSession('later');
    assert.equal(await contextOf('later'), undefined);
  });

  it('session の updatedAt も一覧の並びも変えない', async () => {
    await addSession('old', T - 60_000);
    await addSession('new', T);
    await post(full('old'));
    const st = await state();
    assert.deepEqual(st.sessions.map((s) => s.id), ['new', 'old']);
    assert.equal(st.sessions[1].updatedAt, T - 60_000);
    assert.deepEqual(st.sessions[1].context, FULL_CONTEXT);
    assert.equal(st.sessions[0].context, undefined);
  });

  it('以降の hook イベントがあっても、context は残る', async () => {
    await addSession('s1');
    await post(full('s1'));
    await addSession('s1', T + 1000);
    assert.deepEqual(await contextOf('s1'), FULL_CONTEXT);
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: 項目ごとの検証', () => {
  freshServer();

  it('used_percentage（コンテキスト）: 0〜100 の有限の数値だけ。不正ならその項目だけ捨てる', async () => {
    await addSession('s1');
    const base = { total_input_tokens: 5, context_window_size: 10 };
    for (const used_percentage of [0, 100, 0.1]) {
      await post({ session_id: 's1', context_window: { ...base, used_percentage } });
      assert.deepEqual(await contextOf('s1'), { used_percentage, tokens: 5, window: 10 });
    }
    for (const bad of [-0.1, 100.1, '50', null, true, [1], {}]) {
      await post({ session_id: 's1', context_window: { ...base, used_percentage: 1 } });
      await post({ session_id: 's1', context_window: { ...base, used_percentage: bad } });
      assert.deepEqual(await contextOf('s1'), { tokens: 5, window: 10 }, JSON.stringify(bad));
    }
    await post({ session_id: 's1', context_window: { ...base, used_percentage: 1 } });
    await post('{"session_id":"s1","context_window":{"used_percentage":1e999,"total_input_tokens":5,"context_window_size":10}}');
    assert.deepEqual(await contextOf('s1'), { tokens: 5, window: 10 });
  });

  it('total_input_tokens: 0〜1e9 の整数。context_window_size: 1〜1e9 の整数', async () => {
    await addSession('s1');
    for (const [total_input_tokens, context_window_size] of [[0, 1], [1e9, 1e9]]) {
      await post({ session_id: 's1', context_window: { total_input_tokens, context_window_size } });
      assert.deepEqual(await contextOf('s1'), { tokens: total_input_tokens, window: context_window_size });
    }
    for (const bad of [-1, 1.5, 1e9 + 1, '3', null]) {
      await post({ session_id: 's1', context_window: { used_percentage: 1, total_input_tokens: 1, context_window_size: 1 } });
      await post({ session_id: 's1', context_window: { used_percentage: 2, total_input_tokens: bad, context_window_size: bad } });
      assert.deepEqual(await contextOf('s1'), { used_percentage: 2 }, JSON.stringify(bad));
    }
    await post({ session_id: 's1', context_window: { used_percentage: 3, total_input_tokens: 7, context_window_size: 0 } });
    assert.deepEqual(await contextOf('s1'), { used_percentage: 3, tokens: 7 });
  });

  it('model.display_name: 空でない 100 文字以下の文字列', async () => {
    await addSession('s1');
    const cw = { used_percentage: 1 };
    await post({ session_id: 's1', context_window: cw, model: { display_name: 'm'.repeat(100) } });
    assert.deepEqual(await contextOf('s1'), { used_percentage: 1, model: 'm'.repeat(100) });
    for (const model of [{ display_name: '' }, { display_name: 'm'.repeat(101) }, { display_name: 5 }, {}, 'Opus', null, ['Opus']]) {
      await post({ session_id: 's1', context_window: cw, model: { display_name: 'before' } });
      await post({ session_id: 's1', context_window: cw, model });
      assert.deepEqual(await contextOf('s1'), { used_percentage: 1 }, JSON.stringify(model));
    }
  });

  it('session_id: 空でない 256 文字以下の文字列。不正なら context は付けず、利用枠は採用する', async () => {
    const long = 'a'.repeat(256);
    await addSession(long);
    await addSession('a'.repeat(257));
    await addSession('123');
    await post(full(long));
    assert.deepEqual(await contextOf(long), FULL_CONTEXT);
    for (const sid of ['a'.repeat(257), 123, '', null, undefined, ['123']]) {
      await post({ ...full('x'), session_id: sid });
    }
    assert.equal(await contextOf('a'.repeat(257)), undefined);
    assert.equal(await contextOf('123'), undefined);
    assert.equal((await state()).sessions.length, 3);
    assert.deepEqual(await usageOf(), FULL_USAGE);
  });

  it('rate_limits の used_percentage が不正な枠は採用せず、他の枠は採用する', async () => {
    await post({ rate_limits: { five_hour: limit(10, RESET), seven_day: limit(20, RESET) } });
    for (const bad of [-1, 101, '30', null]) {
      await post({ rate_limits: { five_hour: { used_percentage: bad, resets_at: RESET + 10 } } });
      assert.deepEqual((await usageOf()).five_hour, limit(10, RESET), JSON.stringify(bad));
    }
    await post({ rate_limits: { five_hour: { resets_at: RESET + 10 }, seven_day: limit(30, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(10, RESET), seven_day: limit(30, RESET) });
    await post({ rate_limits: { five_hour: limit(0, RESET), seven_day: limit(100, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(0, RESET), seven_day: limit(100, RESET) });
  });

  it('resets_at が不正なら、その項目だけ捨てて used_percentage は使う', async () => {
    for (const [i, resets] of [0, -5, 1e11, String(RESET), null].entries()) {
      await post({ rate_limits: { five_hour: { used_percentage: i + 1, resets_at: resets } } });
      assert.deepEqual((await usageOf()).five_hour, limit(i + 1), JSON.stringify(resets));
    }
    await post('{"rate_limits":{"five_hour":{"used_percentage":50,"resets_at":1e999}}}');
    assert.deepEqual((await usageOf()).five_hour, limit(50));
  });

  it('遠すぎる未来の resets_at は捨てる（five_hour は 6 時間、seven_day は 8 日まで）', async () => {
    const now = Math.floor(Date.now() / 1000);
    await post({ rate_limits: { five_hour: limit(1, now + 6 * HOUR + 60), seven_day: limit(2, now + 8 * DAY + 60) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(1), seven_day: limit(2) });
    const five = now + 6 * HOUR - 60;
    const seven = now + 8 * DAY - 60;
    await post({ rate_limits: { five_hour: limit(3, five), seven_day: limit(4, seven) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(3, five), seven_day: limit(4, seven) });
  });

  it('遠すぎる未来の resets_at で枠が固まらない', async () => {
    await post({ rate_limits: { five_hour: limit(1, NOW_SEC + 365 * DAY), seven_day: limit(2, 1e11 - 1) } });
    await post({ rate_limits: { five_hour: limit(3, RESET), seven_day: limit(4, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(3, RESET), seven_day: limit(4, RESET) });
  });

  it('オブジェクトでない context_window / rate_limits / 枠は無視して 204', async () => {
    await addSession('s1');
    await post(full('s1'));
    for (const v of ['x', 5, null, [], true]) {
      await post({ session_id: 's1', context_window: v, rate_limits: v, model: v });
      await post({ session_id: 's1', rate_limits: { five_hour: v, seven_day: v } });
    }
    assert.deepEqual(await usageOf(), FULL_USAGE);
    assert.deepEqual(await contextOf('s1'), FULL_CONTEXT);
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: 利用枠の保持', () => {
  freshServer();

  it('枠ごとに更新し、今回無い枠は前の値を残す', async () => {
    await post({ rate_limits: { five_hour: limit(10, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(10, RESET) });
    await post({ rate_limits: { seven_day: limit(20, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(10, RESET), seven_day: limit(20, RESET) });
    await post({});
    assert.deepEqual(await usageOf(), { five_hour: limit(10, RESET), seven_day: limit(20, RESET) });
  });

  it('保存済みより resets_at が古い枠は無視する。同じか新しければ採用する', async () => {
    await post({ rate_limits: { five_hour: limit(10, RESET), seven_day: limit(20, RESET) } });
    await post({ rate_limits: { five_hour: limit(99, RESET - 1), seven_day: limit(21, RESET) } });
    assert.deepEqual(await usageOf(), { five_hour: limit(10, RESET), seven_day: limit(21, RESET) });
    // 同じ resets_at 内は、下がる値でも最後のものを採用する
    await post({ rate_limits: { seven_day: limit(19, RESET) } });
    assert.deepEqual((await usageOf()).seven_day, limit(19, RESET));
    await post({ rate_limits: { five_hour: limit(1, RESET + 10_000) } });
    assert.deepEqual((await usageOf()).five_hour, limit(1, RESET + 10_000));
  });

  it('resets_at の無い枠も採用する（比較できないので枠ごと置き換える）', async () => {
    await post({ rate_limits: { five_hour: limit(10, RESET) } });
    await post({ rate_limits: { five_hour: limit(11) } });
    assert.deepEqual((await usageOf()).five_hour, limit(11));
  });

  it('/api/clear は利用枠を消さない。context はセッションと一緒に消える', async () => {
    await addSession('s1');
    await post(full('s1'));
    const r = await postJson(srv.port, '/api/clear', {}, { token: srv.token });
    assert.equal(r.status, 204);
    assert.deepEqual((await state()).sessions, []);
    assert.deepEqual(await usageOf(), FULL_USAGE);
    await addSession('s1');
    assert.equal(await contextOf('s1'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: コンテキストの保持', () => {
  freshServer();

  it('context_window の有効な項目が 1 つも無い投稿では、前の値を残す', async () => {
    await addSession('s1');
    await post(full('s1'));
    const bodies = [
      { session_id: 's1' },
      { session_id: 's1', model: { display_name: 'Sonnet' } },
      { session_id: 's1', model: { display_name: 'Sonnet' }, context_window: {} },
      { session_id: 's1', context_window: { used_percentage: null, total_input_tokens: -1, context_window_size: 0 } },
    ];
    for (const b of bodies) {
      await post(b);
      assert.deepEqual(await contextOf('s1'), FULL_CONTEXT, JSON.stringify(b));
    }
  });

  it('有効な項目が 1 つでもあれば、その投稿の内容に丸ごと置き換える', async () => {
    await addSession('s1');
    await post(full('s1'));
    await post({ session_id: 's1', context_window: { total_input_tokens: 3 } });
    assert.deepEqual(await contextOf('s1'), { tokens: 3 });
  });

  it('コンテキストはセッションごと', async () => {
    await addSession('s1');
    await addSession('s2');
    await post({ session_id: 's1', context_window: { used_percentage: 1 } });
    await post({ session_id: 's2', context_window: { used_percentage: 2 } });
    assert.deepEqual(await contextOf('s1'), { used_percentage: 1 });
    assert.deepEqual(await contextOf('s2'), { used_percentage: 2 });
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: 認証と本文の検証', () => {
  freshServer();

  const send = (body, headers = { 'content-type': 'application/json' }) => request(srv.port, { method: 'POST', path: '/api/usage', headers, body });

  it('content-type が application/json でなければ 415（charset 付きは受ける）', async () => {
    const body = JSON.stringify(full('x'));
    assert.equal((await send(body, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await send(body, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await send(body, {})).status, 415);
    assert.equal(await usageOf(), null);
    assert.equal((await send(body, { 'content-type': 'Application/JSON; charset=utf-8' })).status, 204);
  });

  it('本文が 64KB を超えたら 413。以内なら受ける', async () => {
    const sized = (n) => {
      const head = JSON.stringify({ rate_limits: { five_hour: limit(5, RESET) }, pad: '' });
      return head.replace('"pad":""', `"pad":"${'x'.repeat(n - head.length)}"`);
    };
    assert.equal((await send(sized(64 * 1024 + 1))).status, 413);
    assert.equal(await usageOf(), null);
    assert.equal((await send(sized(64 * 1024))).status, 204);
    assert.deepEqual((await usageOf()).five_hour, limit(5, RESET));
  });

  it('不正な JSON やオブジェクトでない値は 400', async () => {
    for (const body of ['{not json', '', '[1,2]', '5', '"x"', 'null', 'true']) {
      assert.equal((await send(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await usageOf(), null);
  });

  it('Host が許可外・Origin が他サイト・cross-site の fetch は 403', async () => {
    const json = { 'content-type': 'application/json' };
    const cases = [
      { ...json, host: `evil.com:${srv.port}` },
      { ...json, origin: 'http://evil.com' },
      { ...json, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    ];
    for (const headers of cases) {
      assert.equal((await send(JSON.stringify(full('x')), headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(await usageOf(), null);
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: 配信', () => {
  freshServer();

  /** /stream を開き、届いたスナップショットを messages にためる */
  const openStream = () => new Promise((resolve, reject) => {
    const messages = [];
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: `/stream?key=${srv.token}` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) messages.push(JSON.parse(chunk.slice(6)));
        }
      });
      res.on('error', () => {});
      resolve({ messages, close: () => req.destroy() });
    });
    req.on('error', reject);
  });

  it('値が変わったときだけ配信する', async () => {
    await addSession('s1');
    await sleep(200); // セッション作成の配信を流しきる
    const stream = await openStream();
    try {
      const received = (n) => waitFor(() => stream.messages.length >= n, { timeout: 3000 });
      assert.ok(await received(1), '最初の 1 通が届かない');
      const quiet = async (body, label) => {
        const n = stream.messages.length;
        await post(body);
        await sleep(250); // 配信は 80ms まとめて送る
        assert.equal(stream.messages.length, n, `${label} で配信された`);
      };
      const changes = async (body, label) => {
        const n = stream.messages.length;
        await post(body);
        assert.ok(await received(n + 1), `${label} で配信されない`);
        return stream.messages.at(-1);
      };

      await quiet({}, '空の投稿');
      await quiet({ session_id: 'unknown', context_window: { used_percentage: 1 } }, '知らないセッションの context');

      const first = await changes(full('s1'), '最初の投稿');
      assert.deepEqual(first.usage, FULL_USAGE);
      assert.deepEqual(first.sessions[0].context, FULL_CONTEXT);

      await quiet(full('s1'), '同じ投稿');
      await quiet({ ...full('s1'), cost: { total_cost_usd: 99 } }, '無視する項目だけの変化');
      await quiet({ rate_limits: { five_hour: limit(99, RESET - 1) } }, '古い resets_at');

      const ctx = await changes({ session_id: 's1', context_window: { used_percentage: 43 } }, 'context の変化');
      assert.deepEqual(ctx.sessions[0].context, { used_percentage: 43 });
      const lim = await changes({ rate_limits: { five_hour: limit(13, RESET) } }, '利用枠の変化');
      assert.deepEqual(lim.usage.five_hour, limit(13, RESET));
    } finally {
      stream.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('使用状況: トークンを持たない読み手には見せない', () => {
  freshServer({ env: { AGENT_VIZ_STRICT_KEY: '1' } });

  const firstSseMessage = (urlPath) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: urlPath }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('\n\n')) { req.destroy(); resolve(JSON.parse(buf.slice('data: '.length, buf.indexOf('\n\n')))); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('SSE の最初の1通が届かない')); }, 5000).unref();
  });

  it('/api/state と /stream は、トークンが無ければ usage は null で context を含めない', async () => {
    await addSession('s1');
    await post(full('s1'));
    const readers = [
      await getState(srv.port),
      JSON.parse((await request(srv.port, { path: `/api/state?key=${'d'.repeat(48)}` })).body),
      await firstSseMessage('/stream'),
    ];
    for (const st of readers) {
      assert.equal(st.usage, null);
      assert.equal(st.sessions.length, 1);
      assert.equal('context' in st.sessions[0], false);
    }
    const trusted = [
      await getState(srv.port, { headers: { 'x-agent-viz-token': srv.token } }),
      JSON.parse((await request(srv.port, { path: `/api/state?key=${srv.token}` })).body),
      await firstSseMessage(`/stream?key=${srv.token}`),
    ];
    for (const st of trusted) {
      assert.deepEqual(st.usage, FULL_USAGE);
      assert.deepEqual(st.sessions[0].context, FULL_CONTEXT);
    }
  });
});
