#!/usr/bin/env node
// 記録済みのイベントを実際の時間間隔で再生して、UI の見た目を試す。
// 使い方: node bin/demo.mjs [速度倍率=3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_VIZ_PORT || 4777);
const speed = Number(process.argv[2] || 3);
const rows = fs.readFileSync(path.join(here, '..', 'demo', 'sample-events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sid = 'demo-' + Date.now();
const t0 = rows[0].t;
const start = Date.now();
console.log(`再生中… http://localhost:${PORT} を開いてください`);
for (const ev of rows) {
  const wait = (ev.t - t0) / speed - (Date.now() - start);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await fetch(`http://127.0.0.1:${PORT}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...ev, session_id: sid, t: Date.now() }),
  }).catch(() => { console.error('サーバーに接続できません。先に node server/server.mjs を起動してください'); process.exit(1); });
}
console.log('再生完了');
