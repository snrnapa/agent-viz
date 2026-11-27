// 使用状況（利用枠とコンテキスト使用量）の抽出と保持。依存ゼロ。
// statusline が Claude Code から受けた JSON をそのまま POST /api/usage に送る。設計は docs/workspace-design.md の「使用状況」。
import { isDeepStrictEqual } from 'node:util';

// 利用枠ごとの、resets_at として受け付ける「現在から先」の上限（秒）。枠の長さに余裕を足した値。
// 遠すぎる値を一度受けると、以後の正しい値が古いと扱われて枠が固まる。ミリ秒で書かれた値もここで落ちる
const RESET_AHEAD_SEC = { five_hour: 6 * 60 * 60, seven_day: 8 * 24 * 60 * 60 };
const MAX_COUNT = 1e9;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPercent = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const isCount = (v, min) => Number.isInteger(v) && v >= min && v <= MAX_COUNT;

/** 利用枠 1 つ。used_percentage が不正なら null。resets_at は不正ならそれだけ落とす */
function extractLimit(w, latestReset) {
  if (!isObj(w) || !isPercent(w.used_percentage)) return null;
  const out = { used_percentage: w.used_percentage };
  const r = w.resets_at;
  if (typeof r === 'number' && r > 0 && r <= latestReset) out.resets_at = r;
  return out;
}

/** セッションのコンテキスト。context_window に有効な項目が 1 つも無ければ null（model だけでは作らない） */
function extractContext(body) {
  const w = body.context_window;
  if (!isObj(w)) return null;
  const out = {};
  if (isPercent(w.used_percentage)) out.used_percentage = w.used_percentage;
  if (isCount(w.total_input_tokens, 0)) out.tokens = w.total_input_tokens;
  if (isCount(w.context_window_size, 1)) out.window = w.context_window_size;
  if (!Object.keys(out).length) return null;
  const model = body.model?.display_name;
  if (isStr(model, 100)) out.model = model;
  return out;
}

export class UsageStore {
  /**
   * @param {{ sessions: Map<string, any>, onChange?: () => void, now?: () => number }} opts
   */
  constructor({ sessions, onChange = () => {}, now = Date.now }) {
    this.sessions = sessions;
    this.onChange = onChange;
    this.now = now;
    this.limits = {}; // 利用枠はアカウント全体のものなので、サーバーで 1 つ。/api/clear では消さない
  }

  /** statusline の JSON（オブジェクト）を取り込む。値が変わったときだけ onChange を呼ぶ */
  record(body) {
    let changed = false;
    const nowSec = this.now() / 1000;
    for (const [key, ahead] of Object.entries(RESET_AHEAD_SEC)) {
      const next = extractLimit(body.rate_limits?.[key], nowSec + ahead);
      if (!next) continue;
      const prev = this.limits[key];
      // 放置されたセッションが送る古い枠は無視する。どちらかに resets_at が無いと比較は false になり、置き換える
      if (next.resets_at < prev?.resets_at) continue;
      if (isDeepStrictEqual(prev, next)) continue;
      this.limits[key] = next;
      changed = true;
    }
    // コンテキストは知っているセッションにだけ付ける。セッションは作らず、updatedAt（並びと TTL）も変えない
    const session = isStr(body.session_id, 256) ? this.sessions.get(body.session_id) : undefined;
    const context = session && extractContext(body);
    if (context && !isDeepStrictEqual(session.context, context)) {
      session.context = context;
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** 利用枠。データが無ければ null */
  snapshot() {
    return Object.keys(this.limits).length ? { ...this.limits } : null;
  }
}
