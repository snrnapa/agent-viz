// bin/hook.mjs の結合テスト。hook を子プロセスで起動し、偽の HTTP サーバーで受けた /event の中身を確かめる。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hook.mjs');
const SECRET = 'SECRET-CONTENT-DO-NOT-SEND';

describe('bin/hook.mjs: ワークスペース用の file と term の転送', () => {
  let port;
  let server;
  let received; // 受け取った /event の本文（JSON の配列）

  before(async () => {
    port = await freePort();
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/event') received.push({ method: req.method, raw: body, json: safeParse(body) });
        res.writeHead(204).end();
      });
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  });
  after(() => new Promise((r) => server.close(r)));

  const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  /** hook を 1 回走らせ、受け取った最後の /event を返す（送られなければ null） */
  async function run(input, extraEnv = {}) {
    const before = received.length;
    const env = { PATH: process.env.PATH, AGENT_VIZ_PORT: String(port), AGENT_VIZ_AUTOSTART: '0', ...extraEnv };
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, 'hook は常に exit 0');
    assert.equal(stdout, '', 'hook は何も出力しない');
    return received.length > before ? received[received.length - 1] : null;
  }

  const base = { session_id: 'hook-ws', cwd: '/home/user/proj', hook_event_name: 'PostToolUse' };

  it('相対パスの file は cwd で解決した絶対パスで送る（png・md・txt・svg・jpeg など）', async () => {
    const ev = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'out/chart.PNG', content: 'x' } });
    assert.equal(ev.json.file, '/home/user/proj/out/chart.PNG');
    const md = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'README.md' } });
    assert.equal(md.json.file, '/home/user/proj/README.md');
    const svg = await run({ ...base, tool_name: 'Edit', tool_input: { file_path: '/abs/a.svg' } });
    assert.equal(svg.json.file, '/abs/a.svg');
    const jpg = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'x.jpeg' } });
    assert.equal(jpg.json.file, '/home/user/proj/x.jpeg');
  });

  it('filename・path の形で渡されても file として扱う', async () => {
    const ev = await run({ ...base, tool_name: 'NotebookEdit', tool_input: { path: 'notes/a.txt' } });
    assert.equal(ev.json.file, '/home/user/proj/notes/a.txt');
  });

  it('対象外の拡張子（ts・json・拡張子なし）は file を送らない', async () => {
    const ts = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'src/app.ts', content: 'x' } });
    assert.equal('file' in ts.json, false);
    const json = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'data.json' } });
    assert.equal('file' in json.json, false);
    const none = await run({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal('file' in none.json, false);
  });

  it('作成・編集のツール（Write・Edit・MultiEdit・NotebookEdit）の完了時は file を送る', async () => {
    for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const ev = await run({ ...base, tool_name, tool_input: { file_path: 'a.md' } });
      assert.equal(ev.json.file, '/home/user/proj/a.md', tool_name);
    }
  });

  it('読んだだけのツール（Read・Grep・Glob など）は file を送らない', async () => {
    for (const tool_name of ['Read', 'Grep', 'Glob', 'Bash', 'toString']) {
      const ev = await run({ ...base, tool_name, tool_input: { file_path: 'a.md', path: 'docs/b.md' } });
      assert.equal('file' in ev.json, false, tool_name);
    }
  });

  it('実行前（PreToolUse）は、まだ作られていない（拒否されるかもしれない）ので file を送らない', async () => {
    const ev = await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.md' } });
    assert.equal('file' in ev.json, false);
  });

  it('ファイルの中身（content など）は送らない', async () => {
    const ev = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'a.md', content: SECRET } });
    assert.equal(ev.raw.includes(SECRET), false);
    assert.equal(ev.json.file, '/home/user/proj/a.md');
  });

  it('AGENT_VIZ_TERM があれば term として送る（無ければ送らない）', async () => {
    const withTerm = await run({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }, { AGENT_VIZ_TERM: 'av-0123abcd' });
    assert.equal(withTerm.json.term, 'av-0123abcd');
    const without = await run({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal('term' in without.json, false);
  });

  it('term と file は同じイベントで一緒に送られる', async () => {
    const ev = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'shot.png' } }, { AGENT_VIZ_TERM: 'av-89abcdef' });
    assert.equal(ev.json.term, 'av-89abcdef');
    assert.equal(ev.json.file, '/home/user/proj/shot.png');
    assert.equal(ev.json.event, 'PostToolUse');
    assert.equal(ev.json.session_id, 'hook-ws');
  });

  it('AGENT_VIZ_DISABLE=1 のときは送らない', async () => {
    const ev = await run({ ...base, tool_name: 'Write', tool_input: { file_path: 'no.png' } }, { AGENT_VIZ_DISABLE: '1' });
    assert.equal(ev, null);
  });
});

describe('bin/hook.mjs: セッション名（session_title）の転送', () => {
  let port;
  let server;
  let received;

  before(async () => {
    port = await freePort();
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(204).end(); });
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  });
  after(() => new Promise((r) => server.close(r)));

  async function run(input) {
    received.length = 0;
    const env = { PATH: process.env.PATH, AGENT_VIZ_PORT: String(port), AGENT_VIZ_AUTOSTART: '0' };
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify(input));
    await new Promise((r) => child.on('close', r));
    return received[0];
  }

  const base = { session_id: 'hook-title', cwd: '/home/user/proj', hook_event_name: 'UserPromptSubmit', prompt: 'p' };

  it('session_title は title として送る', async () => {
    const ev = await run({ ...base, session_title: 'アプリの動作確認' });
    assert.equal(ev.title, 'アプリの動作確認');
  });

  it('session_title が無い・空なら title を送らない', async () => {
    assert.equal('title' in (await run(base)), false);
    assert.equal('title' in (await run({ ...base, session_title: '' })), false);
  });

  it('長い名前は 200 文字で切り詰める', async () => {
    const ev = await run({ ...base, session_title: 'あ'.repeat(500) });
    assert.equal(ev.title, 'あ'.repeat(200) + '…');
  });
});
