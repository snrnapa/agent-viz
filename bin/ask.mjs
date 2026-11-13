#!/usr/bin/env node
// 盤面からの回答を待つ hook（PermissionRequest / PreToolUse(AskUserQuestion) / Stop）。
// サーバーへ /api/ask で問い合わせ、回答が来たら hook の出力 JSON を標準出力へ書く。
// どんな失敗・時間切れでも何も出力せず exit 0（fail-open: 端末の従来の動作に戻る）。
// サーバーの自動起動はしない（それは hook.mjs の役割）。設計は docs/board-input-design.md。
import { readToken } from '../server/auth.mjs';

const PORT = Number(process.env.AGENT_VIZ_PORT || 4777);
const HOST = process.env.AGENT_VIZ_HOST || '127.0.0.1';
const URL_BASE = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;

// 待ち時間（秒）。環境変数が不正なら既定値
function waitMs(envName, defaultSec) {
  const n = Number(process.env[envName]);
  return Math.round((Number.isFinite(n) && n > 0 ? n : defaultSec) * 1000);
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v) => (v === undefined || v === null ? '' : String(v));

// 許可ダイアログに出す要約（ツール入力の主要な項目）
function permissionSummary(tool, ti) {
  const parts = [];
  if (ti.description) parts.push(str(ti.description));
  const main = ti.command ?? ti.file_path ?? ti.url ?? ti.pattern ?? ti.query ?? ti.path;
  if (main !== undefined) parts.push(str(main));
  return clip(parts.join('\n') || str(tool), 1500);
}

// AskUserQuestion の質問を盤面用に整える。質問文は回答の key になるので上限を 2000（サーバーの key 上限と揃える）
function questionPayload(ti) {
  if (!Array.isArray(ti.questions) || ti.questions.length === 0) return null;
  // 質問文を切り詰めると回答の key が元の質問文とずれるので、長すぎる場合は端末に任せる
  if (ti.questions.some((q) => str(q?.question).length > 2000)) return null;
  // 盤面で答えられるのは最大 10 問。切り詰めると一部にしか答えられないので、超えるなら端末に任せる
  if (ti.questions.length > 10) return null;
  return {
    questions: ti.questions.slice(0, 10).map((q) => ({
      question: clip(str(q?.question), 2000),
      header: clip(str(q?.header), 100),
      multiSelect: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : []).slice(0, 20).map((o) => ({
        label: clip(str(o?.label), 200),
        description: clip(str(o?.description), 500),
      })),
    })),
  };
}

// hook の入力から、種別・payload・待ち時間を決める。対象外なら null
function plan(ev) {
  const ti = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  switch (ev.hook_event_name) {
    case 'PermissionRequest': {
      // 質問ツールの許可は PreToolUse(AskUserQuestion) で扱うので対象外
      if (ev.tool_name === 'AskUserQuestion') return null;
      const input = JSON.stringify(ti) ?? '{}';
      return {
        kind: 'permission',
        payload: {
          tool_name: str(ev.tool_name),
          summary: permissionSummary(ev.tool_name, ti),
          input_preview: clip(input, 2000),
        },
        wait: waitMs('AGENT_VIZ_WAIT_PERMISSION_SEC', 120),
      };
    }
    case 'PreToolUse': {
      if (ev.tool_name !== 'AskUserQuestion') return null;
      const payload = questionPayload(ti);
      if (!payload) return null;
      return { kind: 'question', payload, wait: waitMs('AGENT_VIZ_WAIT_QUESTION_SEC', 300) };
    }
    case 'Stop':
      return {
        kind: 'followup',
        payload: { last_message: clip(str(ev.last_assistant_message), 1000) },
        wait: waitMs('AGENT_VIZ_WAIT_FOLLOWUP_SEC', 600),
      };
    default:
      return null;
  }
}

// サーバーの answer を hook の出力 JSON に変換する。何も出さないなら null
function output(p, ev, answer) {
  if (!answer || typeof answer !== 'object' || answer.skip) return null;
  const ti = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  if (p.kind === 'permission') {
    if (answer.behavior === 'allow') {
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    }
    if (answer.behavior === 'deny') {
      const message = typeof answer.message === 'string' && answer.message ? answer.message : '盤面で拒否されました';
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
    }
    return null;
  }
  if (p.kind === 'question') {
    const src = answer.answers;
    if (!src || typeof src !== 'object') return null;
    // 全質問に回答があるときだけ返す（一部だけなら端末で答えてもらう）
    const answers = {};
    for (const q of p.payload.questions) {
      const v = src[q.question];
      if (typeof v !== 'string' || !v.trim()) return null;
      answers[q.question] = v;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...ti, answers },
      },
    };
  }
  if (p.kind === 'followup') {
    if (typeof answer.text !== 'string' || !answer.text.trim()) return null;
    return {
      decision: 'block',
      reason: `ユーザーが agent-viz の盤面から次の指示を送りました。\n\n${answer.text}`,
    };
  }
  return null;
}

async function main() {
  if (process.env.AGENT_VIZ_DISABLE === '1') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  if (!ev || typeof ev !== 'object' || typeof ev.session_id !== 'string' || !ev.session_id) return;

  const p = plan(ev);
  if (!p) return;
  const token = readToken(PORT);
  if (!token) return;

  const res = await fetch(`${URL_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-viz-token': token },
    body: JSON.stringify({ kind: p.kind, session_id: ev.session_id, payload: p.payload, wait_ms: p.wait }),
    signal: AbortSignal.timeout(p.wait + 5000),
  });
  if (res.status !== 200) return;
  const body = await res.json();
  const out = output(p, ev, body?.answer);
  if (out) process.stdout.write(JSON.stringify(out));
}

main()
  .catch(() => {})
  .finally(() => { process.exitCode = 0; });
