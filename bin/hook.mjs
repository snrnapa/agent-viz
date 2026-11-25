#!/usr/bin/env node
// Claude Code の hook から呼ばれ、イベントを agent-viz サーバーへ送る。
// どんな失敗があっても Claude Code の動作を止めないよう、常に exit 0 で何も出力しない。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PORT = Number(process.env.AGENT_VIZ_PORT || 4777);
const HOST = process.env.AGENT_VIZ_HOST || '127.0.0.1';
const URL_BASE = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

// 送るデータを小さくする（ファイル内容や長い出力は送らない）
function slim(ev) {
  const out = {
    t: Date.now(),
    event: ev.hook_event_name,
    session_id: ev.session_id,
    cwd: ev.cwd,
    agent_id: ev.agent_id,
    agent_type: ev.agent_type,
    tool_name: ev.tool_name,
    tool_use_id: ev.tool_use_id,
  };
  const ti = ev.tool_input || {};
  if (ev.tool_name === 'Agent' || ev.tool_name === 'Task') {
    out.agent_call = {
      description: ti.description,
      prompt: clip(ti.prompt, 4000),
      subagent_type: ti.subagent_type || 'general-purpose',
      model: ti.model,
      background: !!ti.run_in_background,
    };
    const r = ev.tool_response;
    if (r && typeof r === 'object') {
      out.agent_result = {
        agentId: r.agentId,
        status: r.status,
        resolvedModel: r.resolvedModel,
        totalTokens: r.totalTokens,
        totalDurationMs: r.totalDurationMs,
        totalToolUseCount: r.totalToolUseCount,
      };
    }
  } else if (ev.tool_name) {
    // 何をしているかが一目で分かる程度の要約だけ送る
    out.tool_summary = clip(
      ti.description || ti.command || ti.file_path || ti.pattern || ti.url || ti.query || ti.path || '',
      160,
    );
  }
  // ワークスペース画面から起動した端末との対応づけ
  if (process.env.AGENT_VIZ_TERM) out.term = process.env.AGENT_VIZ_TERM;
  // /rename などで付けたセッション名。SessionStart と UserPromptSubmit の入力にだけ含まれる
  if (ev.session_title) out.title = clip(ev.session_title, 200);
  // プレビュー欄に出せるファイル（画像・Markdown など）のパス。中身は送らない
  const file = ti.file_path || ti.filename || ti.path;
  if (typeof file === 'string' && /\.(png|jpe?g|gif|webp|svg|md|txt)$/i.test(file)) {
    out.file = path.resolve(ev.cwd || '/', file);
  }
  if (ev.prompt) out.prompt = clip(ev.prompt, 4000);
  if (ev.last_assistant_message) out.message = clip(ev.last_assistant_message, 6000);
  if (ev.message) out.notification = clip(ev.message, 500);
  if (ev.source) out.source = ev.source;
  return out;
}

function post(body) {
  return fetch(`${URL_BASE}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(800),
  });
}

function startServer() {
  // 多重起動を避けるための簡易ロック
  const lock = path.join(os.tmpdir(), `agent-viz-${PORT}.lock`);
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 10_000) return;
  } catch {}
  try { fs.writeFileSync(lock, String(process.pid)); } catch {}
  const logFile = path.join(os.tmpdir(), `agent-viz-${PORT}.log`);
  let fd = 'ignore';
  try { fd = fs.openSync(logFile, 'a'); } catch {}
  const child = spawn(process.execPath, [path.join(here, '..', 'server', 'server.mjs')], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
}

async function main() {
  if (process.env.AGENT_VIZ_DISABLE === '1') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  const body = slim(ev);
  try {
    await post(body);
  } catch {
    if (process.env.AGENT_VIZ_AUTOSTART === '0') return;
    startServer();
    // サーバーの起動を少し待ってから1回だけ再送
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { await post(body); return; } catch {}
    }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
