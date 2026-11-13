#!/usr/bin/env node
// agent-viz サーバー: 依存ゼロ。hook からイベントを受け取り、ブラウザへ SSE で状態を配信する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AGENT_VIZ_PORT || 4777);
const HOST = process.env.AGENT_VIZ_HOST || '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, 'public', 'index.html');

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
      break;
  }
  scheduleBroadcast();
}

function snapshot() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  return {
    now,
    sessions: [...sessions.values()]
      .sort((x, y) => y.updatedAt - x.updatedAt)
      .map(({ pending, ...rest }) => ({
        ...rest,
        pending: pending.filter((p) => !p.claimed).map((p) => p.call),
        agents: Object.values(rest.agents).sort((x, y) => x.startedAt - y.startedAt),
      })),
  };
}

let timer = null;
function scheduleBroadcast() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 80);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/event') {
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
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot()));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/clear') {
    sessions.clear();
    scheduleBroadcast();
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) return res.writeHead(500).end('index.html not found');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(buf);
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
});
