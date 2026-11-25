#!/usr/bin/env node
// agent-viz サーバー: 依存ゼロ。hook からイベントを受け取り、ブラウザへ SSE で状態を配信する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedHosts, checkRequest, loadOrCreateToken, mayReceiveToken, tokensEqual } from './auth.mjs';
import { AskStore, KINDS } from './asks.mjs';

const PORT = Number(process.env.AGENT_VIZ_PORT || 4777);
const HOST = process.env.AGENT_VIZ_HOST || '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, 'public', 'index.html');

// 盤面からの回答（許可・質問・次の指示）用。設計は docs/board-input-design.md
const { token: TOKEN, persisted: TOKEN_PERSISTED } = loadOrCreateToken(PORT);
// AGENT_VIZ_HOST が具体的なホスト名なら、hook.mjs が送る Host ヘッダ（HOST:PORT）も許可する
const SELF_HOST = HOST === '0.0.0.0' || HOST === '::' ? '' : `${HOST}:${PORT}`;
const ALLOWED = allowedHosts(PORT, [process.env.AGENT_VIZ_ALLOWED_HOSTS, SELF_HOST].filter(Boolean).join(','));
const STRICT_KEY = process.env.AGENT_VIZ_STRICT_KEY === '1';
// 接続元の UID を確認できない環境（macOS など）で、ループバックからの接続を信用する（1 ユーザーのマシン向け）
const TRUST_LOOPBACK = process.env.AGENT_VIZ_TRUST_LOOPBACK === '1';
const asks = new AskStore({ onChange: scheduleBroadcast });

/** @type {Map<string, any>} */
const sessions = new Map();
const clients = new Set();

const MAX_LOG = 40;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getSession(ev) {
  let s = sessions.get(ev.session_id);
  if (!s) {
    s = {
      id: ev.session_id,
      cwd: ev.cwd || '',
      name: path.basename(ev.cwd || '') || ev.session_id?.slice(0, 8),
      status: 'idle', // idle | running | waiting | ended
      turn: 0,
      prompt: '',
      message: '',
      questions: [],
      notice: '',
      activity: null,
      log: [],
      agents: {},
      pending: [],
      startedAt: ev.t,
      updatedAt: ev.t,
    };
    sessions.set(ev.session_id, s);
  }
  if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.name = path.basename(ev.cwd); }
  s.updatedAt = ev.t;
  return s;
}

// 報告文から「疑問・確認したいこと」を抜き出す
const Q_HEAD = /(疑問|質問|確認したい|確認事項|不明点|要確認|判断に迷|open questions?|questions?)/i;
function extractQuestions(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const isHead = /^(【.*】|#{1,6}\s|\*\*.*\*\*:?$|[^\s].{0,30}[:：]$)/.test(line);
    if (isHead) {
      inSection = Q_HEAD.test(line);
      // 見出しと同じ行に内容がある場合（例: 【疑問】〜〜）
      const rest = line.replace(/^【[^】]*】\s*/, '');
      if (inSection && rest && rest !== line && !/^(なし|特になし|none)$/i.test(rest)) out.push(rest);
      continue;
    }
    if (inSection && line) {
      const item = line.replace(/^([-*・]|\d+[.)])\s*/, '');
      if (item && !/^(なし|特になし|none|n\/a)\.?$/i.test(item)) out.push(item);
    }
  }
  if (out.length) return out.slice(0, 6);
  // 見出しが無い場合は疑問文っぽい行を拾う
  inCode = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (!inCode && /[?？]\s*$/.test(line) && line.length > 4) out.push(line.replace(/^([-*・]|\d+[.)])\s*/, ''));
  }
  return out.slice(0, 4);
}

function pushLog(target, entry) {
  target.log.push(entry);
  if (target.log.length > MAX_LOG) target.log.splice(0, target.log.length - MAX_LOG);
}

function newAgent(s, id, type, call, t) {
  const a = {
    id,
    type: type || call?.subagent_type || 'agent',
    description: call?.description || '',
    prompt: call?.prompt || '',
    model: call?.model || '',
    background: !!call?.background,
    status: 'running', // running | done | question
    activity: null,
    toolCount: 0,
    tokens: 0,
    message: '',
    questions: [],
    log: [],
    turn: s.turn,
    startedAt: t,
    endedAt: null,
  };
  s.agents[id] = a;
  return a;
}

const RECORD = process.env.AGENT_VIZ_RECORD; // デバッグ用: 受け取ったイベントを jsonl に追記
function handle(ev) {
  if (!ev || !ev.session_id || !ev.event) return;
  if (RECORD) { try { fs.appendFileSync(RECORD, JSON.stringify(ev) + '\n'); } catch {} }
  const s = getSession(ev);
  const a = ev.agent_id ? s.agents[ev.agent_id] : null;

  switch (ev.event) {
    case 'SessionStart':
      if (s.status === 'ended') s.status = 'idle';
      break;

    case 'UserPromptSubmit':
      // バックグラウンドのサブエージェント完了通知などはプロンプトとして届くので、新しい指示として扱わない
      if (/^\s*<(task-notification|system-reminder|local-command|command-)/.test(ev.prompt || '')) {
        s.status = 'running';
        break;
      }
      s.turn += 1;
      s.prompt = ev.prompt || '';
      s.status = 'running';
      s.message = '';
      s.questions = [];
      s.notice = '';
      s.pending = [];
      s.log = [];
      break;

    case 'PreToolUse': {
      if (s.status !== 'running') s.status = 'running';
      s.notice = '';
      if ((ev.tool_name === 'Agent' || ev.tool_name === 'Task') && ev.agent_call) {
        s.pending.push({ tool_use_id: ev.tool_use_id, call: ev.agent_call, t: ev.t });
        pushLog(s, { t: ev.t, tool: 'Agent', summary: `${ev.agent_call.description || ''} を依頼` });
        break;
      }
      const act = { tool: ev.tool_name, summary: ev.tool_summary || '', t: ev.t, done: false };
      if (ev.agent_id) {
        const ag = a || newAgent(s, ev.agent_id, ev.agent_type, null, ev.t);
        ag.activity = act;
        ag.toolCount += 1;
        if (ag.status !== 'running') ag.status = 'running';
        pushLog(ag, act);
      } else {
        s.activity = act;
        pushLog(s, act);
      }
      break;
    }

    case 'PostToolUse': {
      if ((ev.tool_name === 'Agent' || ev.tool_name === 'Task') && ev.agent_result?.agentId) {
        const r = ev.agent_result;
        const ag = s.agents[r.agentId] || newAgent(s, r.agentId, ev.agent_call?.subagent_type, ev.agent_call, ev.t);
        if (ev.agent_call) {
          ag.description = ev.agent_call.description || ag.description;
          ag.prompt = ev.agent_call.prompt || ag.prompt;
          ag.model = ev.agent_call.model || ag.model;
        }
        if (r.resolvedModel) ag.model = r.resolvedModel;
        if (r.totalTokens) ag.tokens = r.totalTokens;
        s.pending = s.pending.filter((p) => p.tool_use_id !== ev.tool_use_id);
        break;
      }
      const target = ev.agent_id ? a : s;
      if (target?.activity) target.activity.done = true;
      break;
    }

    case 'SubagentStart': {
      // 直前の Agent 呼び出し（担当・モデル）と結びつける
      let idx = s.pending.findIndex((p) => p.call.subagent_type === ev.agent_type && !p.claimed);
      if (idx < 0) idx = s.pending.findIndex((p) => !p.claimed);
      const p = idx >= 0 ? s.pending[idx] : null;
      if (p) p.claimed = true;
      const ag = a || newAgent(s, ev.agent_id, ev.agent_type, p?.call, ev.t);
      if (p && !ag.description) { ag.description = p.call.description; ag.prompt = p.call.prompt; ag.model = p.call.model || ag.model; }
      ag.status = 'running';
      break;
    }

    case 'SubagentStop': {
      const ag = a || newAgent(s, ev.agent_id, ev.agent_type, null, ev.t);
      ag.message = ev.message || '';
      ag.questions = extractQuestions(ag.message);
      ag.status = ag.questions.length ? 'question' : 'done';
      ag.endedAt = ev.t;
      if (ag.activity) ag.activity.done = true;
      break;
    }

    case 'Stop':
      s.status = 'idle';
      s.message = ev.message || '';
      s.questions = extractQuestions(s.message);
      if (s.activity) s.activity.done = true;
      break;

    case 'Notification':
      s.notice = ev.notification || '';
      if (/permission|許可|waiting|input/i.test(s.notice)) s.status = 'waiting';
      break;

    case 'SessionEnd':
      s.status = 'ended';
      asks.clearSession(ev.session_id);
      break;
  }
  scheduleBroadcast();
}

// redact=true のとき、ask の中身（コマンド・質問文など）は含めない（トークンを持たない読み手向け）
function snapshot(redact = false) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      asks.clearSession(id);
    }
  }
  // トークンは含めない（ページには meta タグで別途渡す）
  return {
    now,
    settings: asks.publicSettings(),
    sessions: [...sessions.values()]
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .map(({ pending, ...rest }) => ({
        ...rest,
        pending: pending.filter((p) => !p.claimed).map((p) => p.call),
        agents: Object.values(rest.agents).sort((x, y) => x.startedAt - y.startedAt),
        followup: asks.isFollowup(rest.id),
        asks: redact ? [] : asks.listFor(rest.id),
      })),
  };
}

let timer = null;
function scheduleBroadcast() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    // 読み手ごとに、ask の中身を含むか（トークンを持つ画面）含まないかを切り替える
    let full = null;
    let redacted = null;
    for (const res of clients) {
      if (res.agentVizTrusted) res.write(full ??= `data: ${JSON.stringify(snapshot(false))}\n\n`);
      else res.write(redacted ??= `data: ${JSON.stringify(snapshot(true))}\n\n`);
    }
  }, 80);
}

// ask の中身を読んでよい相手か。トークン（ヘッダ・?key=）を持つか、ページにトークンを渡せる相手と同じ条件
function readerTrusted(req, url) {
  if (tokensEqual(req.headers['x-agent-viz-token'], TOKEN)) return true;
  return mayReceiveToken(req, url, TOKEN, { strict: STRICT_KEY, trustLoopback: TRUST_LOOPBACK });
}

// トークンが要る（書き込み系）エンドポイント
const TOKEN_PATHS = new Set(['/api/ask', '/api/answer', '/api/presence', '/api/settings', '/api/clear']);
const SMALL_BODY = 64 * 1024; // 盤面からの JSON 本文の上限
const EVENT_BODY = 2e6; // /event の上限（既存）

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

function sendJson(res, status, obj) {
  if (status === 413) res.setHeader('connection', 'close');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));
}

// JSON 本文を読む。上限超過は 413、不正な JSON やオブジェクトでない値は 400
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        reject(new HttpError(413, 'payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let v;
      try {
        v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(bad('invalid json'));
        return;
      }
      if (!isObj(v)) {
        reject(bad('body must be an object'));
        return;
      }
      resolve(v);
    });
    req.on('error', reject);
  });
}

// 非同期ハンドラの例外を HTTP 応答に変換する
async function handleApi(res, fn) {
  try {
    await fn();
  } catch (e) {
    if (res.headersSent || res.destroyed) return;
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error('api error', e.message);
    sendJson(res, 500, { error: 'internal error' });
  }
}

// hook が待つ。回答が来たら 200 {answer}、時間切れ・取り下げなら 204
async function apiAsk(req, res) {
  const b = await readJson(req, SMALL_BODY);
  if (!KINDS.includes(b.kind)) throw bad('invalid kind');
  if (!isStr(b.session_id, 256)) throw bad('invalid session_id');
  if (!isObj(b.payload)) throw bad('invalid payload');
  if (typeof b.wait_ms !== 'number' || !Number.isFinite(b.wait_ms)) throw bad('invalid wait_ms');
  // 盤面に出ていないセッションの ask は誰にも見えないので、待たずに端末へ戻す
  if (!sessions.has(b.session_id) || !asks.canWait(b.kind, b.session_id)) return res.writeHead(204).end();
  const ask = asks.create({ session_id: b.session_id, kind: b.kind, payload: b.payload, waitMs: b.wait_ms });
  if (!ask) return sendJson(res, 429, { error: 'too many pending asks' });
  // 待つ側の切断で取り下げる。Node 16 以降 req の close は本文読了時にも発火するので、res を見る
  res.on('close', () => {
    if (!res.writableEnded) ask.cancel();
  });
  const answer = await ask.promise;
  if (res.destroyed) return;
  if (answer === null) return res.writeHead(204).end();
  sendJson(res, 200, { answer });
}

// ブラウザからの回答。受理なら 200、未処理・不正な回答なら 404
async function apiAnswer(req, res) {
  const b = await readJson(req, SMALL_BODY);
  if (!isStr(b.id, 64)) throw bad('invalid id');
  if (!asks.answer(b.id, b.answer)) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, { ok: true });
}

async function apiPresence(req, res) {
  const b = await readJson(req, SMALL_BODY);
  if (!isStr(b.client, 64)) throw bad('invalid client');
  if (typeof b.visible !== 'boolean') throw bad('invalid visible');
  asks.setPresence(b.client, b.visible);
  res.writeHead(204).end();
}

async function apiSettings(req, res) {
  const b = await readJson(req, SMALL_BODY);
  const hasAnswer = 'answerEnabled' in b;
  const hasFollowup = 'followup' in b;
  if (!hasAnswer && !hasFollowup) throw bad('nothing to update');
  if (hasAnswer && typeof b.answerEnabled !== 'boolean') throw bad('invalid answerEnabled');
  if (hasFollowup) {
    const f = b.followup;
    if (!isObj(f) || !isStr(f.session_id, 256) || typeof f.enabled !== 'boolean') throw bad('invalid followup');
  }
  // 検証がすべて済んでから適用する
  if (hasAnswer) asks.setAnswerEnabled(b.answerEnabled);
  if (hasFollowup) asks.setFollowup(b.followup.session_id, b.followup.enabled);
  res.writeHead(204).end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const check = checkRequest(req, { allowed: ALLOWED, token: TOKEN, needToken: TOKEN_PATHS.has(url.pathname) });
  if (!check.ok) {
    req.resume();
    return sendJson(res, check.status, { error: check.reason });
  }
  if (req.method === 'POST' && url.pathname === '/api/ask') return handleApi(res, () => apiAsk(req, res));
  if (req.method === 'POST' && url.pathname === '/api/answer') return handleApi(res, () => apiAnswer(req, res));
  if (req.method === 'POST' && url.pathname === '/api/presence') return handleApi(res, () => apiPresence(req, res));
  if (req.method === 'POST' && url.pathname === '/api/settings') return handleApi(res, () => apiSettings(req, res));

  if (req.method === 'POST' && url.pathname === '/event') {
    // 既存の hook 互換のためトークンは不要。JSON 以外は受けない（ブラウザの text/plain 送信を弾く）
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      req.resume();
      return sendJson(res, 415, { error: 'content-type must be application/json' });
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { handle(JSON.parse(body)); } catch (e) { console.error('bad event', e.message); }
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.agentVizTrusted = readerTrusted(req, url);
    res.write(`data: ${JSON.stringify(snapshot(!res.agentVizTrusted))}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot(!readerTrusted(req, url))));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/clear') {
    for (const id of sessions.keys()) asks.clearSession(id);
    sessions.clear();
    scheduleBroadcast();
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX, 'utf8', (err, html) => {
      if (err) return res.writeHead(500).end('index.html not found');
      let out = html;
      // ループバックからの接続、または ?key= が一致するときだけトークンを埋め込む
      const i = html.indexOf('</head>');
      if (i >= 0 && mayReceiveToken(req, url, TOKEN, { strict: STRICT_KEY, trustLoopback: TRUST_LOOPBACK })) {
        out = `${html.slice(0, i)}<meta name="agent-viz-token" content="${TOKEN}">${html.slice(i)}`;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 他サイトに埋め込まれて、許可ボタンを誤クリックさせられるのを防ぐ
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      }).end(out);
    });
    return;
  }
  res.writeHead(404).end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`port ${PORT} is already in use; exiting`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`agent-viz: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  // トークン本体は出さない
  console.log(TOKEN_PERSISTED
    ? 'agent-viz: token saved (hook can read it; board answers enabled)'
    : 'agent-viz: token could not be saved; hook cannot read it, so board answers are unavailable');
});
