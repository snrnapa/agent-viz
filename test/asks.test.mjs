// server/asks.mjs の単体テスト（validateAnswer と AskStore）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AskStore, KINDS, MAX_PENDING, MAX_WAIT_MS, MIN_WAIT_MS, PRESENCE_TTL_MS, validateAnswer } from '../server/asks.mjs';

const payload = { tool_name: 'Bash', summary: 'ls', input_preview: '{}' };

/** 時計を差し替えた AskStore。clock.t を進めて時間を操作する。 */
function fakeStore(start = 1_000_000) {
  const clock = { t: start, changes: 0 };
  const store = new AskStore({ now: () => clock.t, onChange: () => { clock.changes += 1; } });
  return { store, clock };
}

describe('validateAnswer', () => {
  it('skip は種別によらず {skip:true} になる', () => {
    for (const kind of KINDS) assert.deepEqual(validateAnswer(kind, { skip: true }), { skip: true }, kind);
  });

  it('permission: allow / deny を受け付ける。message は 500 文字まで', () => {
    assert.deepEqual(validateAnswer('permission', { behavior: 'allow' }), { behavior: 'allow' });
    assert.deepEqual(validateAnswer('permission', { behavior: 'deny', message: 'やめて' }), { behavior: 'deny', message: 'やめて' });
    assert.equal(validateAnswer('permission', { behavior: 'deny', message: 'あ'.repeat(600) }).message.length, 500);
  });

  it('permission: behavior が不正なら null', () => {
    assert.equal(validateAnswer('permission', {}), null);
    assert.equal(validateAnswer('permission', { behavior: 'maybe' }), null);
    assert.equal(validateAnswer('permission', { behavior: 'ALLOW' }), null);
  });

  it('permission: 空の message と非文字列の message は落として、behavior だけ残す', () => {
    assert.deepEqual(validateAnswer('permission', { behavior: 'deny', message: '' }), { behavior: 'deny' });
    assert.deepEqual(validateAnswer('permission', { behavior: 'allow', message: 123 }), { behavior: 'allow' });
  });

  it('question: answers は 1〜10 件。値は空でない文字列で、2000 文字まで', () => {
    assert.deepEqual(validateAnswer('question', { answers: { 'Q?': 'A' } }), { answers: { 'Q?': 'A' } });
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Q${i}`, 'x']));
    assert.equal(Object.keys(validateAnswer('question', { answers: ten }).answers).length, 10);
    assert.equal(validateAnswer('question', { answers: { 'Q?': 'a'.repeat(2500) } }).answers['Q?'].length, 2000);
  });

  it('question: 件数オーバー・空・空白だけ・非文字列・配列は null', () => {
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Q${i}`, 'x']));
    assert.equal(validateAnswer('question', { answers: eleven }), null);
    assert.equal(validateAnswer('question', { answers: {} }), null);
    assert.equal(validateAnswer('question', { answers: { 'Q?': '' } }), null);
    assert.equal(validateAnswer('question', { answers: { 'Q?': '   ' } }), null);
    assert.equal(validateAnswer('question', { answers: { 'Q?': 123 } }), null);
    assert.equal(validateAnswer('question', { answers: [] }), null);
    assert.equal(validateAnswer('question', {}), null);
  });

  it('followup: text は空白だけ・非文字列を拒否し、20000 文字まで', () => {
    assert.deepEqual(validateAnswer('followup', { text: '次に進めて' }), { text: '次に進めて' });
    assert.equal(validateAnswer('followup', { text: '  ' }), null);
    assert.equal(validateAnswer('followup', { text: 5 }), null);
    assert.equal(validateAnswer('followup', { text: 'a'.repeat(25000) }).text.length, 20000);
  });

  it('オブジェクトでない入力は null', () => {
    for (const v of [null, undefined, 'allow', 42, ['allow']]) assert.equal(validateAnswer('permission', v), null, String(v));
  });

  it('種別と形が合わない回答は null', () => {
    assert.equal(validateAnswer('question', { behavior: 'allow' }), null);
    assert.equal(validateAnswer('permission', { text: 'x' }), null);
    assert.equal(validateAnswer('followup', { answers: { 'Q?': 'a' } }), null);
  });
});

describe('AskStore.canWait', () => {
  it('盤面が見えていなければ待たない（presence が無い）', () => {
    const { store } = fakeStore();
    store.setFollowup('s', true);
    assert.equal(store.canWait('permission', 's'), false);
    assert.equal(store.canWait('question', 's'), false);
    assert.equal(store.canWait('followup', 's'), false);
  });

  it('visible: false の presence だけなら待たない', () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', false);
    assert.equal(store.canWait('permission', 's'), false);
  });

  it('見えているタブがあれば permission と question は待つ', () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    assert.equal(store.canWait('permission', 's'), true);
    assert.equal(store.canWait('question', 's'), true);
  });

  it('followup は、そのセッションの待機モードがオンのときだけ待つ', () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    assert.equal(store.canWait('followup', 's'), false);
    store.setFollowup('s', true);
    assert.equal(store.canWait('followup', 's'), true);
    assert.equal(store.canWait('followup', 'other'), false);
  });

  it('「盤面で回答する」がオフなら、見えていても待たない', () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    store.setAnswerEnabled(false);
    assert.equal(store.canWait('permission', 's'), false);
    store.setAnswerEnabled(true);
    assert.equal(store.canWait('permission', 's'), true);
  });

  it('不正な kind は待たない', () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    assert.equal(store.canWait('bogus', 's'), false);
  });

  it('presence は 25 秒で失効する。visible は届くたびに更新される', () => {
    const { store, clock } = fakeStore();
    store.setPresence('tab-a', true);
    clock.t += PRESENCE_TTL_MS;
    assert.equal(store.watching(), true);
    clock.t += 1;
    assert.equal(store.watching(), false);
    store.setPresence('tab-a', true);
    assert.equal(store.watching(), true);
  });

  it('不正な client 名の presence は無視する', () => {
    const { store } = fakeStore();
    store.setPresence('', true);
    store.setPresence('x'.repeat(65), true);
    store.setPresence(123, true);
    assert.equal(store.watching(), false);
  });
});

describe('AskStore.create / answer', () => {
  it('create は id・promise・cancel を返し、listFor には公開する項目だけを出す', () => {
    const { store } = fakeStore();
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 5000 });
    assert.match(a.id, /^[0-9a-f]{24}$/);
    assert.equal(typeof a.cancel, 'function');
    const [item] = store.listFor('s');
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'expiresAt', 'id', 'kind', 'payload']);
    assert.equal(item.kind, 'permission');
    assert.deepEqual(store.listFor('other'), []);
    a.cancel();
  });

  it('答えると promise が検証済みの回答で解決し、一覧から消える', async () => {
    const { store } = fakeStore();
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 5000 });
    assert.equal(store.answer(a.id, { behavior: 'deny', message: 'だめ' }), true);
    assert.deepEqual(await a.promise, { behavior: 'deny', message: 'だめ' });
    assert.equal(store.has(a.id), false);
  });

  it('二重回答は 2 回目が false。回答済みの promise は変わらない', async () => {
    const { store } = fakeStore();
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 5000 });
    assert.equal(store.answer(a.id, { behavior: 'allow' }), true);
    assert.equal(store.answer(a.id, { behavior: 'deny' }), false);
    assert.deepEqual(await a.promise, { behavior: 'allow' });
  });

  it('不正な回答は false で、ask は残る（後から正しく答えられる）', async () => {
    const { store } = fakeStore();
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 5000 });
    assert.equal(store.answer(a.id, { behavior: 'maybe' }), false);
    assert.equal(store.has(a.id), true);
    assert.equal(store.answer(a.id, { behavior: 'allow' }), true);
    assert.deepEqual(await a.promise, { behavior: 'allow' });
  });

  it('存在しない id への回答は false', () => {
    const { store } = fakeStore();
    assert.equal(store.answer('0'.repeat(24), { behavior: 'allow' }), false);
  });

  it('cancel すると promise は null で解決し、一覧から消える', async () => {
    const { store } = fakeStore();
    const a = store.create({ session_id: 's', kind: 'question', payload, waitMs: 5000 });
    a.cancel();
    assert.equal(await a.promise, null);
    assert.equal(store.has(a.id), false);
  });

  it('待ち時間は 1 秒〜15 分にクランプする', () => {
    const { store } = fakeStore();
    const span = (waitMs) => {
      const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs });
      const item = store.listFor('s').find((x) => x.id === a.id);
      a.cancel();
      return item.expiresAt - item.createdAt;
    };
    assert.equal(span(0), MIN_WAIT_MS);
    assert.equal(span(Number.NaN), MIN_WAIT_MS);
    assert.equal(span(5000), 5000);
    assert.equal(span(10 ** 9), MAX_WAIT_MS);
    assert.equal(MIN_WAIT_MS, 1000);
    assert.equal(MAX_WAIT_MS, 900_000);
  });

  it('状態が変わるたびに onChange が呼ばれる', () => {
    const { store, clock } = fakeStore();
    const before = clock.changes;
    store.setPresence('tab-a', true);
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 5000 });
    store.answer(a.id, { behavior: 'allow' });
    assert.equal(clock.changes - before, 3);
  });

  it('未処理の ask が上限（50 件）に達すると create は null', () => {
    const { store } = fakeStore();
    assert.equal(MAX_PENDING, 50);
    const made = [];
    for (let i = 0; i < MAX_PENDING; i++) made.push(store.create({ session_id: 's', kind: 'permission', payload, waitMs: 900_000 }));
    assert.equal(store.create({ session_id: 's', kind: 'permission', payload, waitMs: 900_000 }), null);
    for (const a of made) a.cancel();
    assert.ok(store.create({ session_id: 's', kind: 'permission', payload, waitMs: 900_000 }));
  });
});

describe('AskStore: 取り下げ', () => {
  it('setFollowup(false) は、そのセッションの followup だけを取り下げる', async () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    store.setFollowup('s1', true);
    store.setFollowup('s2', true);
    const f1 = store.create({ session_id: 's1', kind: 'followup', payload: {}, waitMs: 5000 });
    const p1 = store.create({ session_id: 's1', kind: 'permission', payload, waitMs: 5000 });
    const f2 = store.create({ session_id: 's2', kind: 'followup', payload: {}, waitMs: 5000 });
    store.setFollowup('s1', false);
    assert.equal(await f1.promise, null);
    assert.equal(store.has(f1.id), false);
    assert.equal(store.has(p1.id), true);
    assert.equal(store.has(f2.id), true);
    assert.equal(store.isFollowup('s1'), false);
    assert.equal(store.isFollowup('s2'), true);
    p1.cancel();
    f2.cancel();
  });

  it('setFollowup(true) は待っている ask を取り下げない', () => {
    const { store } = fakeStore();
    const p = store.create({ session_id: 's1', kind: 'permission', payload, waitMs: 5000 });
    store.setFollowup('s1', true);
    assert.equal(store.has(p.id), true);
    p.cancel();
  });

  it('setAnswerEnabled(false) は全部の ask を取り下げる（presence は影響しない）', async () => {
    const { store } = fakeStore();
    store.setPresence('tab-a', true);
    store.setFollowup('s1', true);
    const list = [
      store.create({ session_id: 's1', kind: 'permission', payload, waitMs: 5000 }),
      store.create({ session_id: 's1', kind: 'question', payload, waitMs: 5000 }),
      store.create({ session_id: 's1', kind: 'followup', payload: {}, waitMs: 5000 }),
    ];
    store.setAnswerEnabled(false);
    for (const a of list) assert.equal(await a.promise, null);
    assert.equal(store.publicSettings().answerEnabled, false);
    assert.equal(store.publicSettings().watching, true);
    store.setAnswerEnabled(true);
    assert.equal(store.canWait('permission', 's1'), true);
  });

  it('clearSession は、そのセッションの ask と待機モードを消し、他のセッションは残す', async () => {
    const { store } = fakeStore();
    store.setFollowup('s1', true);
    const a = store.create({ session_id: 's1', kind: 'permission', payload, waitMs: 5000 });
    const b = store.create({ session_id: 's2', kind: 'permission', payload, waitMs: 5000 });
    store.clearSession('s1');
    assert.equal(await a.promise, null);
    assert.equal(store.isFollowup('s1'), false);
    assert.equal(store.has(b.id), true);
    b.cancel();
  });
});

describe('AskStore: 実時間の時間切れ', () => {
  it('回答が来ないまま待ち時間が過ぎると null で解決し、一覧からも消える（1 秒）', async () => {
    const store = new AskStore();
    const a = store.create({ session_id: 's', kind: 'permission', payload, waitMs: 1000 });
    // AskStore のタイマーは unref なので、単体テストでは ref 付きのタイマーでイベントループを保つ
    const keepAlive = setTimeout(() => {}, 1500);
    const t0 = Date.now();
    const result = await a.promise;
    clearTimeout(keepAlive);
    assert.equal(result, null);
    assert.ok(Date.now() - t0 >= 900, 'timed out too early');
    assert.equal(store.has(a.id), false);
  });
});
