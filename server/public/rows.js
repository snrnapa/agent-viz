// ワークスペース画面の左の一覧の行の種類・状態・並び順・ディレクトリ分けと、使用状況の表示内容（DOM を使わない関数だけ）。
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

  // 作業中でも終了でもなく、質問が残っている。
  // 今のターンのサブエージェントが作業中の間は、確認待ちを除いて作業の途中とみなす。
  // 盤面（index.html）との違い: 盤面は終了したセッションも質問が残れば疑問扱いにするが、
  // 一覧では終了にする（もう答えられないセッションを上に並べない）
  function asksBack(s) {
    if (!s?.questions?.length || s.status === 'running' || s.status === 'ended') return false;
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

  // ===== 使用状況（利用枠とコンテキスト使用量）。データの形は docs/workspace-design.md の「使用状況」 =====
  const STALE_TEXT = '古い値（リセット済み）';
  const isPercent = (v) => typeof v === 'number' && v >= 0 && v <= 100;
  // 小数は切り捨てる（79.9 を 80% と出して「注意」のままにしない）
  const percent = (v) => ({ value: Math.floor(v), text: `${Math.floor(v)}%` });

  /** コンテキスト使用量の段階: ''、'caution'（50% 以上）、'warn'（80% 以上） */
  const contextLevel = (p) => (p >= 80 ? 'warn' : p >= 50 ? 'caution' : '');
  const LEVEL_LABEL = { '': '', caution: '注意', warn: '警告' };

  /** 行に出すコンテキスト使用量。出さないときは null */
  function rowContext({ t, s }) {
    const p = s?.context?.used_percentage;
    // 端末のある行の終了したセッションは前のもの（シェルに戻った行・次の起動直後の行）
    if (!isPercent(p) || (t && s.status === 'ended')) return null;
    const level = contextLevel(p);
    return { ...percent(p), level, label: LEVEL_LABEL[level] };
  }

  const hasReset = (resetsAt) => Number.isFinite(resetsAt) && resetsAt > 0;
  const isPast = (resetsAt, nowMs) => hasReset(resetsAt) && resetsAt * 1000 <= nowMs;

  /** resets_at（epoch 秒）までの残り時間の文字列。過ぎていれば古い値の表示、値が無ければ空 */
  function remainingText(resetsAt, nowMs) {
    if (!hasReset(resetsAt)) return '';
    if (isPast(resetsAt, nowMs)) return STALE_TEXT;
    const min = Math.floor((resetsAt * 1000 - nowMs) / 60000);
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d) return `あと ${d}日${h ? `${h}時間` : ''}`;
    if (h) return `あと ${h}時間${m ? `${m}分` : ''}`;
    return m ? `あと ${m}分` : 'あと 1分未満';
  }

  const LIMITS = [['five_hour', '5時間'], ['seven_day', '7日間']];

  /** ヘッダーに出す利用枠（5時間、7日間の順）。データが無ければ空 */
  function usageItems(usage, nowMs) {
    return LIMITS.flatMap(([key, name]) => {
      const w = usage?.[key];
      if (!isPercent(w?.used_percentage)) return [];
      return [{ key, name, ...percent(w.used_percentage), stale: isPast(w.resets_at, nowMs), remain: remainingText(w.resets_at, nowMs) }];
    });
  }

  globalThis.AgentVizRows = { rowKind, rowStatus, rowPill, isEnded, compareRows, groupRows,
    contextLevel, rowContext, remainingText, usageItems };
})();
