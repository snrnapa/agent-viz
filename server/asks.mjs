// 盤面への「回答待ち」を管理する。依存ゼロ。
// hook が /api/ask で待ち、ブラウザが /api/answer で答える。設計は docs/board-input-design.md。
import crypto from 'node:crypto';

export const KINDS = ['permission', 'question', 'followup'];
export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 900_000;
export const PRESENCE_TTL_MS = 25_000;
export const MAX_PENDING = 50;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * ブラウザからの回答を正規化する。不正なら null。
 * 返す形: {skip:true} | permission {behavior,message?} | question {answers} | followup {text}
 */
export function validateAnswer(kind, a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (a.skip === true) return { skip: true };
  if (kind === 'permission') {
    if (a.behavior !== 'allow' && a.behavior !== 'deny') return null;
    const out = { behavior: a.behavior };
    const m = str(a.message, 500);
    if (m) out.message = m;
    return out;
  }
  if (kind === 'question') {
    const src = a.answers;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    const keys = Object.keys(src);
    if (keys.length === 0 || keys.length > 10) return null;
    const answers = {};
    for (const k of keys) {
      const v = str(src[k], 2000);
      if (v === null || !v.trim()) return null;
      answers[k.slice(0, 2000)] = v;
    }
    return { answers };
  }
  if (kind === 'followup') {
    const t = str(a.text, 20_000);
    if (t === null || !t.trim()) return null;
    return { text: t };
  }
  return null;
}

export class AskStore {
  /**
   * @param {{ onChange?: () => void, now?: () => number }} [opts]
   */
  constructor({ onChange = () => {}, now = Date.now } = {}) {
    this.onChange = onChange;
    this.now = now;
    this.settings = { answerEnabled: true };
    this.presence = new Map(); // client -> { visible, ts }
    this.followup = new Set(); // 待機モードがオンの session_id
    this.asks = new Map(); // id -> { id, session_id, kind, payload, createdAt, expiresAt, settle, timer }
  }

  setAnswerEnabled(on) {
    this.settings.answerEnabled = !!on;
    if (!on) for (const id of [...this.asks.keys()]) this.#settle(id, null);
    this.onChange();
  }

  setPresence(client, visible) {
    if (typeof client !== 'string' || !client || client.length > 64) return;
    const t = this.now();
    for (const [c, p] of this.presence) if (t - p.ts > PRESENCE_TTL_MS) this.presence.delete(c);
    this.presence.set(client, { visible: !!visible, ts: t });
    this.onChange();
  }

  /** 見えているタブが今あるか */
  watching() {
    const t = this.now();
    for (const p of this.presence.values()) if (p.visible && t - p.ts <= PRESENCE_TTL_MS) return true;
    return false;
  }

  setFollowup(sessionId, enabled) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (enabled) this.followup.add(sessionId);
    else {
      this.followup.delete(sessionId);
      for (const a of [...this.asks.values()]) if (a.kind === 'followup' && a.session_id === sessionId) this.#settle(a.id, null);
    }
    this.onChange();
  }

  isFollowup(sessionId) {
    return this.followup.has(sessionId);
  }

  canWait(kind, sessionId) {
    if (!KINDS.includes(kind)) return false;
    if (!this.settings.answerEnabled || !this.watching()) return false;
    return kind !== 'followup' || this.followup.has(sessionId);
  }

  /**
   * 回答待ちを登録する。
   * @returns {{ id: string, promise: Promise<object|null>, cancel: () => void } | null} 上限超過なら null
   */
  create({ session_id, kind, payload, waitMs }) {
    if (this.asks.size >= MAX_PENDING) return null;
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Number(waitMs) || MIN_WAIT_MS));
    const id = crypto.randomBytes(12).toString('hex');
    const createdAt = this.now();
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.#settle(id, null), wait);
    timer.unref?.();
    this.asks.set(id, { id, session_id, kind, payload, createdAt, expiresAt: createdAt + wait, settle, timer });
    this.onChange();
    return { id, promise, cancel: () => this.#settle(id, null) };
  }

  /** ブラウザからの回答。受理したら true。 */
  answer(id, raw) {
    const a = this.asks.get(id);
    if (!a) return false;
    const ans = validateAnswer(a.kind, raw);
    if (!ans) return false;
    this.#settle(id, ans);
    return true;
  }

  has(id) {
    return this.asks.has(id);
  }

  clearSession(sessionId) {
    this.followup.delete(sessionId);
    for (const a of [...this.asks.values()]) if (a.session_id === sessionId) this.#settle(a.id, null);
    this.onChange();
  }

  /** スナップショット用（settle などの内部は出さない） */
  listFor(sessionId) {
    return [...this.asks.values()]
      .filter((a) => a.session_id === sessionId)
      .map(({ id, kind, payload, createdAt, expiresAt }) => ({ id, kind, payload, createdAt, expiresAt }));
  }

  publicSettings() {
    return { answerEnabled: this.settings.answerEnabled, watching: this.watching() };
  }

  #settle(id, value) {
    const a = this.asks.get(id);
    if (!a) return;
    this.asks.delete(id);
    clearTimeout(a.timer);
    a.settle(value);
    this.onChange();
  }
}
