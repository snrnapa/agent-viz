// server/public/rows.js（左の一覧の行の種類・状態・並び順・ディレクトリ分けと、使用状況の表示内容）の単体テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../server/public/rows.js';

const { rowKind, rowStatus, rowPill, isEnded, compareRows, groupRows,
  contextLevel, rowContext, remainingText, usageItems } = globalThis.AgentVizRows;

let n = 0;
const row = (cwd, extra = {}) => ({ key: `k${++n}`, cwd, status: 'idle', asks: 0, updated: 0, t: null, ...extra });
const shape = (groups) => groups.map((g) => [g.name, g.hint, g.items.map((i) => i.row.key)]);
const names = (groups) => groups.map((g) => g.name);
const claude = { command: 'claude' };
const bash = { command: 'bash' };

describe('rows: 行の種類（Claude / シェル）', () => {
  const ses = (status) => ({ status });

  it('画面外の行（端末が無い）は Claude', () => {
    assert.equal(rowKind(null, ses('idle')), 'claude');
    assert.equal(rowKind(null, ses('ended')), 'claude');
  });

  it('端末の command が claude なら Claude（手で打った claude も、起動直後でセッションが無くても）', () => {
    assert.equal(rowKind(claude, null), 'claude');
    assert.equal(rowKind(claude, ses('ended')), 'claude');
  });

  it('claude 以外のコマンドで、セッションが無いか終了していればシェル', () => {
    for (const command of ['bash', 'zsh', 'sh', 'vim', 'node', '', undefined, 'claude-x']) {
      assert.equal(rowKind({ command }, null), 'shell', String(command));
      assert.equal(rowKind({ command }, ses('ended')), 'shell', String(command));
    }
  });

  it('claude 以外のコマンドでも、未終了のセッションがあれば Claude（ツール実行中など）', () => {
    for (const status of ['idle', 'running', 'waiting']) assert.equal(rowKind(bash, ses(status)), 'claude', status);
  });
});

describe('rows: 行の状態', () => {
  const ses = (status, questions = [], extra = {}) => ({ status, questions, turn: 2, agents: [], ...extra });
  const q = ['これでよいですか？'];

  it('端末が生きている行は「終了」にしない。画面外の行はセッションの状態', () => {
    assert.equal(rowStatus(bash, ses('ended')), 'idle');
    assert.equal(rowStatus(claude, ses('ended')), 'idle');
    assert.equal(rowStatus(bash, null), 'idle');
    assert.equal(rowStatus(claude, ses('running')), 'running');
    assert.equal(rowStatus(null, ses('ended')), 'ended');
    assert.equal(rowStatus(null, ses('waiting')), 'waiting');
  });

  it('盤面と同じく、作業中でなく質問が残っている行は「疑問あり」', () => {
    for (const status of ['idle', 'waiting']) assert.equal(rowStatus(null, ses(status, q)), 'question', status);
    assert.equal(rowStatus(claude, ses('idle', q)), 'question');
    assert.equal(rowStatus(bash, ses('idle', q)), 'question');
  });

  it('終了したセッションは、質問が残っていても「疑問あり」にしない（盤面とは違う）', () => {
    assert.equal(rowStatus(null, ses('ended', q)), 'ended');
    assert.equal(rowStatus(null, ses('ended', q, { agents: [{ turn: 2, status: 'running' }] })), 'ended');
  });

  it('作業中は、質問があっても作業中のまま', () => {
    assert.equal(rowStatus(null, ses('running', q)), 'running');
  });

  it('今のターンのサブエージェントが作業中なら、盤面と同じく疑問にしない（確認待ちは除く）', () => {
    const busy = { agents: [{ turn: 2, status: 'running' }] };
    assert.equal(rowStatus(null, ses('idle', q, busy)), 'idle');
    assert.equal(rowStatus(null, ses('waiting', q, busy)), 'question');
    assert.equal(rowStatus(null, ses('idle', q, { agents: [{ turn: 1, status: 'running' }] })), 'question');
    assert.equal(rowStatus(null, ses('idle', q, { agents: [{ turn: 2, status: 'done' }] })), 'question');
  });

  it('端末のある行は、シェルに戻った後や次の起動直後に、終了したセッションの質問を引き継がない', () => {
    assert.equal(rowStatus(bash, ses('ended', q)), 'idle');
    assert.equal(rowStatus(claude, ses('ended', q)), 'idle');
  });

  it('questions や agents が無くても動く', () => {
    assert.equal(rowStatus(null, { status: 'idle' }), 'idle');
    assert.equal(rowStatus(null, { status: 'idle', questions: q }), 'question');
  });

  it('薄く出すのは、画面外の終了したセッションの行だけ（質問が残っていても終了は終了）', () => {
    assert.equal(isEnded({ t: null, s: ses('ended') }), true);
    assert.equal(isEnded({ t: null, s: ses('ended', q) }), true);
    assert.equal(isEnded({ t: null, s: ses('idle') }), false);
    assert.equal(isEnded({ t: bash, s: ses('ended') }), false);
    assert.equal(isEnded({ t: bash, s: null }), false);
  });
});

describe('rows: 状態の表示', () => {
  const pill = (t, s, asks = 0) => rowPill({ t, s, asks, kind: rowKind(t, s), status: rowStatus(t, s) });

  it('回答待ちが最優先。2 件以上は件数も出す', () => {
    assert.deepEqual(pill(null, { status: 'running' }, 1), { cls: 'asking', text: '回答待ち' });
    assert.deepEqual(pill(claude, { status: 'idle' }, 3), { cls: 'asking', text: '回答待ち 3' });
  });

  it('シェルの行は「セッション待ち」ではなく「シェル」', () => {
    assert.deepEqual(pill(bash, null), { cls: 'shell', text: 'シェル' });
    assert.deepEqual(pill(bash, { status: 'ended' }), { cls: 'shell', text: 'シェル' });
  });

  it('claude の起動直後（セッションがまだ無い、または前の終了したセッションだけ）は「セッション待ち」', () => {
    assert.deepEqual(pill(claude, null), { cls: 'idle', text: 'セッション待ち' });
    assert.deepEqual(pill(claude, { status: 'ended', questions: ['？'] }), { cls: 'idle', text: 'セッション待ち' });
  });

  it('それ以外はセッションの状態', () => {
    assert.deepEqual(pill(claude, { status: 'running' }), { cls: 'running', text: '作業中' });
    assert.deepEqual(pill(bash, { status: 'waiting' }), { cls: 'waiting', text: 'あなたの確認待ち' });
    assert.deepEqual(pill(claude, { status: 'idle' }), { cls: 'idle', text: '待機中' });
    assert.deepEqual(pill(null, { status: 'idle', questions: ['？'] }), { cls: 'question', text: '疑問あり' });
    assert.deepEqual(pill(null, { status: 'ended' }), { cls: 'ended', text: '終了' });
    assert.deepEqual(pill(null, { status: 'ended', questions: ['？'] }), { cls: 'ended', text: '終了' });
  });
});

describe('rows: 行の順', () => {
  it('回答待ち → 確認待ち・疑問 → 作業中 → 待機 → 終了。同じなら更新が新しい順', () => {
    const rows = [
      { key: 'ended', status: 'ended', asks: 0, updated: 9 },
      { key: 'idle', status: 'idle', asks: 0, updated: 1 },
      { key: 'idle-new', status: 'idle', asks: 0, updated: 5 },
      { key: 'run', status: 'running', asks: 0, updated: 1 },
      { key: 'wait', status: 'waiting', asks: 0, updated: 1 },
      { key: 'q', status: 'question', asks: 0, updated: 2 },
      { key: 'ask', status: 'running', asks: 1, updated: 0 },
    ];
    assert.deepEqual(rows.sort(compareRows).map((r) => r.key), ['ask', 'q', 'wait', 'run', 'idle-new', 'idle', 'ended']);
  });

  it('質問が残った終了セッションの行は、終了の順位（グループも終了だけの段）', () => {
    const s = { status: 'ended', questions: ['？'] };
    const ended = row('/p/a-ended', { status: rowStatus(null, s), s, updated: 9 });
    const idle = row('/p/b-idle', { updated: 1 });
    assert.deepEqual([ended, idle].sort(compareRows).map((r) => r.key), [idle.key, ended.key]);
    const g = groupRows([ended, idle]);
    assert.deepEqual(g.map((x) => [x.name, x.tier]), [['b-idle', 1], ['a-ended', 2]]);
  });
});

describe('rows: コンテキスト使用量', () => {
  const ses = (used_percentage, status = 'idle') => ({ status, context: { used_percentage, tokens: 1000, window: 200000 } });

  it('50% 以上は注意、80% 以上は警告', () => {
    const cases = [[0, ''], [49.9, ''], [50, 'caution'], [79.9, 'caution'], [80, 'warn'], [100, 'warn']];
    for (const [p, level] of cases) assert.equal(contextLevel(p), level, String(p));
  });

  it('数値と段階のラベルを返す。小数は切り捨て（表示の数値と段階が食い違わない）', () => {
    assert.deepEqual(rowContext({ t: null, s: ses(0) }), { value: 0, text: '0%', level: '', label: '' });
    assert.deepEqual(rowContext({ t: null, s: ses(49.9) }), { value: 49, text: '49%', level: '', label: '' });
    assert.deepEqual(rowContext({ t: null, s: ses(50) }), { value: 50, text: '50%', level: 'caution', label: '注意' });
    assert.deepEqual(rowContext({ t: null, s: ses(79.9) }), { value: 79, text: '79%', level: 'caution', label: '注意' });
    assert.deepEqual(rowContext({ t: null, s: ses(80) }), { value: 80, text: '80%', level: 'warn', label: '警告' });
    assert.deepEqual(rowContext({ t: null, s: ses(100) }), { value: 100, text: '100%', level: 'warn', label: '警告' });
  });

  it('セッションや context、使用率が無い行には出さない', () => {
    const sessions = [null, undefined, {}, { context: null }, { context: {} }, { context: { tokens: 10, window: 100 } }];
    for (const s of sessions) assert.equal(rowContext({ t: null, s }), null, JSON.stringify(s));
    assert.equal(rowContext({ t: claude, s: null }), null);
    for (const bad of [null, '50', NaN, Infinity, -1, 101]) assert.equal(rowContext({ t: null, s: ses(bad) }), null, String(bad));
  });

  it('端末のある行は、終了したセッションの値を出さない（シェルに戻った行・次の起動直後の行）', () => {
    assert.equal(rowContext({ t: bash, s: ses(90, 'ended') }), null);
    assert.equal(rowContext({ t: claude, s: ses(90, 'ended') }), null);
  });

  it('端末のある行でも未終了なら出す。画面外の終了した行は、そのセッションの値を出す', () => {
    for (const status of ['idle', 'running', 'waiting']) {
      assert.equal(rowContext({ t: claude, s: ses(10, status) })?.text, '10%', status);
      assert.equal(rowContext({ t: bash, s: ses(10, status) })?.text, '10%', status);
    }
    assert.equal(rowContext({ t: null, s: ses(10, 'ended') })?.text, '10%');
  });
});

const NOW = 1_800_000_000_000; // ミリ秒
const after = (sec) => NOW / 1000 + sec; // resets_at（epoch 秒）
const STALE = '古い値（リセット済み）';

describe('rows: リセットまでの残り時間', () => {
  const HOUR = 3600;
  const DAY = 86400;

  it('分・時間・日で表す（切り捨て。0 の下の単位は省く）', () => {
    const cases = [
      [1, 'あと 1分未満'], [59, 'あと 1分未満'], [60, 'あと 1分'], [HOUR - 1, 'あと 59分'],
      [HOUR, 'あと 1時間'], [2 * HOUR + 13 * 60 + 59, 'あと 2時間13分'], [DAY - 1, 'あと 23時間59分'],
      [DAY, 'あと 1日'], [DAY + 59 * 60, 'あと 1日'], [3 * DAY + 4 * HOUR + 30 * 60, 'あと 3日4時間'],
    ];
    for (const [sec, text] of cases) assert.equal(remainingText(after(sec), NOW), text, String(sec));
  });

  it('resets_at を過ぎていれば、古い値と分かる文字にする', () => {
    for (const sec of [0, -1, -10 * DAY]) assert.equal(remainingText(after(sec), NOW), STALE, String(sec));
  });

  it('resets_at が無いか不正なら空', () => {
    for (const bad of [undefined, null, '1800000000', NaN, Infinity, 0, -5]) assert.equal(remainingText(bad, NOW), '', String(bad));
  });
});

describe('rows: 利用枠の表示', () => {
  const five = { used_percentage: 23.5, resets_at: after(2 * 3600) };
  const seven = { used_percentage: 41, resets_at: after(3 * 86400) };

  it('データが無ければ空（null、古いサーバーの undefined、空や不正な値）', () => {
    for (const u of [undefined, null, {}, 'x', 1, [], { five_hour: null }, { five_hour: {} }]) {
      assert.deepEqual(usageItems(u, NOW), [], JSON.stringify(u));
    }
  });

  it('5時間、7日間の順に、使用率と残り時間を返す', () => {
    assert.deepEqual(usageItems({ seven_day: seven, five_hour: five }, NOW), [
      { key: 'five_hour', name: '5時間', value: 23, text: '23%', stale: false, remain: 'あと 2時間' },
      { key: 'seven_day', name: '7日間', value: 41, text: '41%', stale: false, remain: 'あと 3日' },
    ]);
  });

  it('片方だけでも出す。使用率が不正な枠は出さない', () => {
    assert.deepEqual(usageItems({ seven_day: seven }, NOW).map((x) => x.key), ['seven_day']);
    assert.deepEqual(usageItems({ five_hour: five }, NOW).map((x) => x.key), ['five_hour']);
    for (const bad of [undefined, null, '5', NaN, -1, 101]) {
      assert.deepEqual(usageItems({ five_hour: { ...five, used_percentage: bad }, seven_day: seven }, NOW).map((x) => x.key), ['seven_day'], String(bad));
    }
  });

  it('resets_at が無ければ、残り時間なしで古い扱いにもしない', () => {
    assert.deepEqual(usageItems({ five_hour: { used_percentage: 0 } }, NOW), [
      { key: 'five_hour', name: '5時間', value: 0, text: '0%', stale: false, remain: '' },
    ]);
  });

  it('resets_at を過ぎた枠は stale。時間が進むと、同じデータでも残り時間と stale が変わる', () => {
    const u = { five_hour: { used_percentage: 100, resets_at: after(90) } };
    const at = (sec) => usageItems(u, NOW + sec * 1000)[0];
    assert.deepEqual([at(0).remain, at(0).stale], ['あと 1分', false]);
    assert.deepEqual([at(60).remain, at(60).stale], ['あと 1分未満', false]);
    assert.deepEqual([at(90).remain, at(90).stale, at(90).text], [STALE, true, '100%']);
  });
});

describe('rows: ディレクトリごとのグループ', () => {
  it('同じ cwd をまとめ、見出しはフォルダ名とフルパス。末尾の / の違いで分けない', () => {
    const [a, b, c] = [row('/home/u/app'), row('/home/u/app/'), row('/home/u/app//')];
    const g = groupRows([a, b, c]);
    assert.equal(g.length, 1);
    assert.equal(g[0].name, 'app');
    assert.equal(g[0].path, '/home/u/app');
    assert.equal(g[0].hint, '');
    assert.equal(g[0].items.length, 3);
  });

  it('下位のディレクトリは別のグループ', () => {
    assert.deepEqual(names(groupRows([row('/r/app'), row('/r/app/src')])), ['app', 'src']);
  });

  it('.claude/worktrees/<名前> はリポジトリのグループに入れ、worktree 名を持たせる', () => {
    const main = row('/home/u/repo');
    const wt = row('/home/u/repo/.claude/worktrees/feat-x');
    const sub = row('/home/u/repo/.claude/worktrees/fix-y/server/');
    const g = groupRows([main, wt, sub]);
    assert.equal(g.length, 1);
    assert.equal(g[0].path, '/home/u/repo');
    const byKey = Object.fromEntries(g[0].items.map((i) => [i.row.key, i.worktree]));
    assert.deepEqual(byKey, { [main.key]: '', [wt.key]: 'feat-x', [sub.key]: 'fix-y' });
  });

  it('worktrees のフォルダそのものや .claude は、worktree 扱いにしない', () => {
    assert.deepEqual(names(groupRows([row('/r/repo/.claude/worktrees'), row('/r/repo/.claude')])), ['.claude', 'worktrees']);
  });

  it('cwd の無い行は「場所不明」にまとめ、同じ段の最後に置く', () => {
    const g = groupRows([row(''), row(undefined), row('/z/zzz'), row('  ')]);
    assert.deepEqual(names(g), ['zzz', '場所不明']);
    assert.equal(g[1].path, '');
    assert.equal(g[1].items.length, 3);
  });

  it('「場所不明」という名前の実在フォルダがあっても、cwd の無いグループとは別で、印も付けない', () => {
    const g = groupRows([row('/p/場所不明'), row('')]);
    assert.deepEqual(g.map((x) => [x.path, x.hint]), [['/p/場所不明', ''], ['', '']]);
  });

  it('ルートディレクトリはそのまま', () => {
    const g = groupRows([row('/')]);
    assert.equal(g[0].name, '/');
    assert.equal(g[0].path, '/');
  });

  it('同じフォルダ名は、見分けがつく最短の親フォルダ名を添える', () => {
    const g = groupRows([row('/home/u/work/app'), row('/home/u/play/app'), row('/home/u/other')]);
    assert.deepEqual(g.map((x) => [x.name, x.hint]), [['app', 'play'], ['app', 'work'], ['other', '']]);
    const deep = groupRows([row('/x/work/app'), row('/y/work/app')]);
    assert.deepEqual(deep.map((x) => x.hint), ['x/work', 'y/work']);
  });

  it('片方の親が、もう片方の親の末尾と同じでも見分ける。直下のフォルダは /', () => {
    const g = groupRows([row('/work/app'), row('/x/work/app'), row('/app')]);
    const hints = Object.fromEntries(g.map((x) => [x.path, x.hint]));
    assert.deepEqual(hints, { '/app': '/', '/work/app': '/work', '/x/work/app': 'x/work' });
  });

  it('グループの順: 回答待ち・確認待ち → 稼働中の行や端末 → 終了だけ。同じ段はフォルダ名順', () => {
    const rows = [
      row('/p/a-ended', { status: 'ended', updated: 100 }),
      row('/p/c-idle', { status: 'idle', updated: 50 }),
      row('/p/b-term', { status: 'ended', t: { name: 'av-1' } }),
      row('/p/z-ask', { status: 'running', asks: 1 }),
      row('/p/y-wait', { status: 'waiting' }),
      row('/p/y-wait', { status: 'ended' }),
      row('/p/x-question', { status: 'question' }),
    ];
    assert.deepEqual(names(groupRows(rows)), ['x-question', 'y-wait', 'z-ask', 'b-term', 'c-idle', 'a-ended']);
  });

  it('更新の時刻が変わっても、グループの順は変わらない。グループ内は優先順と新しい順', () => {
    const a1 = row('/p/alpha', { updated: 1 });
    const b1 = row('/p/beta', { updated: 2 });
    const b2 = row('/p/beta', { updated: 3, status: 'running' });
    const b3 = row('/p/beta', { updated: 4 });
    const before = shape(groupRows([a1, b1, b2, b3]));
    assert.deepEqual(before, [['alpha', '', [a1.key]], ['beta', '', [b2.key, b3.key, b1.key]]]);
    a1.updated = 0; b1.updated = 99;
    assert.deepEqual(shape(groupRows([b1, a1, b3, b2])), [['alpha', '', [a1.key]], ['beta', '', [b2.key, b1.key, b3.key]]]);
  });

  it('渡した配列と行は書き換えない', () => {
    const rows = [row('/p/b/', { updated: 1 }), row('/p/a')];
    const copy = JSON.stringify(rows);
    groupRows(rows);
    assert.equal(JSON.stringify(rows), copy);
  });

  it('行が無ければ空', () => {
    assert.deepEqual(groupRows([]), []);
  });
});
