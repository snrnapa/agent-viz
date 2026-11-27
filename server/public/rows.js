// ワークスペース画面の左の一覧の、行の種類・状態・並び順・ディレクトリ分け（DOM を使わない関数だけ）。
// 画面（classic script）と node:test の両方で使う。
(() => {
  const UNKNOWN = '場所不明';
  const STATUS_LABEL = { running: '作業中', done: '完了', question: '疑問あり', idle: '待機中', waiting: 'あなたの確認待ち', ended: '終了' };

  /** その行で今動いているもの: 'claude' か 'shell'。t は端末（画面外の行は null）、s はセッション */
  function rowKind(t, s) {
    if (!t || t.command === 'claude') return 'claude';
    // Claude がツールを実行している間などは command が変わる
    return s && s.status !== 'ended' ? 'claude' : 'shell';
  }

  // 盤面（index.html）と同じ判定: 作業中でなく、質問が残っている。
  // 今のターンのサブエージェントが作業中の間は、確認待ちを除いて作業の途中とみなす
  function asksBack(s) {
    if (!s?.questions?.length || s.status === 'running') return false;
    return s.status === 'waiting' || !s.agents?.some((a) => a.turn === s.turn && a.status === 'running');
  }

  /** 行の状態。端末が生きている行は「終了」にせず、終了したセッションの質問も引き継がない */
  function rowStatus(t, s) {
    const status = s?.status || 'idle';
    if (t && (status === 'ended' || rowKind(t, s) === 'shell')) return 'idle';
    return asksBack(s) ? 'question' : status;
  }

  /** 行に出す状態の表示（色の種類と文字） */
  function rowPill({ t, s, asks, kind, status }) {
    if (asks) return { cls: 'asking', text: asks > 1 ? `回答待ち ${asks}` : '回答待ち' };
    if (kind === 'shell') return { cls: 'shell', text: 'シェル' };
    // claude の起動直後は、セッションがまだ届いていない（前の終了したセッションが紐づいていることもある）
    if (!s || (t && s.status === 'ended')) return { cls: 'idle', text: 'セッション待ち' };
    return { cls: status, text: STATUS_LABEL[status] || status };
  }

  /** 画面外の、終了したセッションの行か（薄く出す） */
  const isEnded = ({ t, s }) => !t && s?.status === 'ended';

  // 回答待ち → 確認待ち・疑問 → 作業中 → 待機 → 終了
  const priority = (r) => (r.asks ? 0 : r.status === 'question' || r.status === 'waiting' ? 1 : r.status === 'running' ? 2 : r.status === 'ended' ? 4 : 3);
  const compareRows = (a, b) => priority(a) - priority(b) || b.updated - a.updated;

  // cwd を、グループにするディレクトリと worktree 名に分ける
  function splitCwd(cwd) {
    let dir = typeof cwd === 'string' && cwd.trim() ? cwd : '';
    let end = dir.length;
    while (end > 1 && dir[end - 1] === '/') end--;
    dir = dir.slice(0, end);
    const m = /\/\.claude\/worktrees\/([^/]+)(?:\/|$)/.exec(dir);
    return m ? { dir: dir.slice(0, m.index) || '/', worktree: m[1] } : { dir, worktree: '' };
  }

  const baseName = (dir) => dir.slice(dir.lastIndexOf('/') + 1) || dir;
  const parents = (dir) => dir.split('/').filter(Boolean).slice(0, -1);

  // 同じ名前のフォルダを見分けるための、親フォルダ名（見分けがつく最短）
  function addHints(groups) {
    const byName = new Map();
    for (const g of groups) if (g.path) byName.set(g.name, [...(byName.get(g.name) || []), g]);
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      const all = same.map((g) => parents(g.path));
      same.forEach((g, i) => {
        const mine = all[i];
        for (let k = 1; k <= mine.length; k++) {
          const tail = mine.slice(-k).join('/');
          if (all.every((other, j) => j === i || other.slice(-k).join('/') !== tail)) { g.hint = tail; return; }
        }
        g.hint = `/${mine.join('/')}`;
      });
    }
  }

  // 回答待ち・確認待ちを含む → 稼働中の行や端末がある → 終了だけ
  function tierOf(items) {
    if (items.some(({ row }) => priority(row) <= 1)) return 0;
    return items.some(({ row }) => row.t || row.status !== 'ended') ? 1 : 2;
  }

  /**
   * 行をディレクトリごとにまとめる。
   * @returns {Array<{ path: string, name: string, hint: string, tier: number, items: Array<{ row: object, worktree: string }> }>}
   * グループの順は段とフォルダ名だけで決める（更新のたびに入れ替わらないように）。
   */
  function groupRows(rows) {
    const map = new Map();
    for (const row of rows) {
      const { dir, worktree } = splitCwd(row.cwd);
      let g = map.get(dir);
      if (!g) map.set(dir, (g = { path: dir, name: dir ? baseName(dir) : UNKNOWN, hint: '', tier: 2, items: [] }));
      g.items.push({ row, worktree });
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.items.sort((a, b) => compareRows(a.row, b.row));
      g.tier = tierOf(g.items);
    }
    addHints(groups);
    return groups.sort((a, b) => a.tier - b.tier || !a.path - !b.path || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  globalThis.AgentVizRows = { rowKind, rowStatus, rowPill, isEnded, compareRows, groupRows };
})();
