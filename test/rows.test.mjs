// server/public/rows.js（左の一覧の行の種類・状態・並び順・ディレクトリ分け）の単体テスト。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../server/public/rows.js';

const { rowKind, rowStatus, rowPill, isEnded, compareRows, groupRows } = globalThis.AgentVizRows;

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
    for (const status of ['idle', 'waiting', 'ended']) assert.equal(rowStatus(null, ses(status, q)), 'question', status);
    assert.equal(rowStatus(claude, ses('idle', q)), 'question');
    assert.equal(rowStatus(bash, ses('idle', q)), 'question');
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
