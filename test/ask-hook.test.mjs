// bin/ask.mjs の結合テスト。hook を子プロセスとして実際に起動し、サーバーと並行して盤面から答える。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  childEnv, freePort, getState, makeTempHome, postJson, registerSession, removeDir, setPresence, spawnHook,
  startServer, stopServer, waitForAsk, waitFor,
} from './helpers.mjs';

const CLIENT = 'hook-browser';
const PERM_ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
let counter = 0;
const newSid = () => `hook-${process.pid}-${++counter}`;

describe('bin/ask.mjs（hook）', () => {
  let srv;
  let env;
  before(async () => {
    srv = await startServer();
    env = childEnv(srv.home, { AGENT_VIZ_PORT: String(srv.port) });
  });
  after(() => stopServer(srv));

  async function present(visible = true) {
    const r = await setPresence(srv.port, srv.token, visible, CLIENT);
    assert.equal(r.status, 204);
  }
  async function session() {
    const sid = newSid();
    assert.equal((await registerSession(srv.port, sid)).status, 204);
    return sid;
  }
  async function answer(id, body) {
    const r = await postJson(srv.port, '/api/answer', { id, answer: body }, { token: srv.token });
    assert.equal(r.status, 200);
  }
  async function asksOf(sid) {
    return (await getState(srv.port)).sessions.find((s) => s.id === sid)?.asks ?? [];
  }
  const permInput = (sid, over = {}) => ({
    hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls -la', description: '一覧' }, ...over,
  });
  const questionInput = (sid, questions) => ({
    hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'AskUserQuestion', tool_input: { questions },
  });
  const questions = [
    { question: 'どの方式にしますか？', header: '方式', multiSelect: false, options: [{ label: 'A案', description: '速い' }, { label: 'B案', description: '丁寧' }] },
    { question: '対象は？', header: '対象', multiSelect: true, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }, { label: 'z', description: '' }] },
  ];

  describe('PermissionRequest', () => {
    it('許可: 盤面で allow すると、決まった形の JSON を標準出力に書く', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(permInput(sid)), env).done;
      const ask = await waitForAsk(srv.port, sid, 'permission');
      assert.ok(ask, 'ask が盤面に出ない');
      assert.match(ask.payload.summary, /ls -la/);
      assert.equal(ask.payload.tool_name, 'Bash');
      await answer(ask.id, { behavior: 'allow' });
      const r = await hook;
      assert.equal(r.code, 0);
      assert.equal(r.stdout, PERM_ALLOW);
    });

    it('拒否: message 付きの deny が出力される', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(permInput(sid, { tool_name: 'Edit', tool_input: { file_path: '/tmp/a.txt' } })), env).done;
      const ask = await waitForAsk(srv.port, sid, 'permission');
      await answer(ask.id, { behavior: 'deny', message: 'やめて' });
      const r = await hook;
      assert.deepEqual(JSON.parse(r.stdout), {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'やめて' } },
      });
    });

    it('拒否で message が無ければ、既定の文言「盤面で拒否されました」', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(permInput(sid, { tool_name: 'Edit', tool_input: {} })), env).done;
      const ask = await waitForAsk(srv.port, sid, 'permission');
      await answer(ask.id, { behavior: 'deny' });
      const r = await hook;
      assert.deepEqual(JSON.parse(r.stdout), {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '盤面で拒否されました' } },
      });
    });

    it('端末で判断（skip）は何も出力せず exit 0', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(permInput(sid, { tool_input: { command: 'pwd' } })), env).done;
      const ask = await waitForAsk(srv.port, sid, 'permission');
      await answer(ask.id, { skip: true });
      const r = await hook;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
    });

    it('AskUserQuestion の許可は対象外。盤面に出さず、何も出力しない', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify(permInput(sid, { tool_name: 'AskUserQuestion', tool_input: { questions } })), env).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 3000, 'サーバーに問い合わせて待ったらしい');
      assert.deepEqual(await asksOf(sid), []);
    });

    it('summary は 1500 文字、input_preview は 2000 文字までに切り詰める', async () => {
      await present();
      const sid = await session();
      const long = 'echo ' + 'a'.repeat(5000);
      const hook = spawnHook(JSON.stringify(permInput(sid, { tool_input: { command: long } })), env).done;
      const ask = await waitForAsk(srv.port, sid, 'permission');
      assert.equal(ask.payload.summary.length, 1500);
      assert.ok(ask.payload.summary.endsWith('…'));
      assert.equal(ask.payload.input_preview.length, 2000);
      await answer(ask.id, { skip: true });
      await hook;
    });
  });

  describe('PreToolUse（AskUserQuestion）', () => {
    it('全問に回答すると、updatedInput.answers を付けて allow を出力する', async () => {
      await present();
      const sid = await session();
      const input = questionInput(sid, questions);
      const hook = spawnHook(JSON.stringify(input), env).done;
      const ask = await waitForAsk(srv.port, sid, 'question');
      assert.equal(ask.payload.questions.length, 2);
      assert.equal(ask.payload.questions[1].multiSelect, true);
      assert.equal(ask.payload.questions[0].options[1].label, 'B案');
      const answers = { 'どの方式にしますか？': 'B案', '対象は？': 'x, z' };
      await answer(ask.id, { answers });
      const r = await hook;
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { questions, answers },
        },
      });
    });

    it('一部だけ回答されたら、何も出力しない（端末で答えてもらう）', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(questionInput(sid, questions)), env).done;
      const ask = await waitForAsk(srv.port, sid, 'question');
      await answer(ask.id, { answers: { 'どの方式にしますか？': 'A案' } });
      const r = await hook;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
    });

    it('端末で答える（skip）は何も出力しない', async () => {
      await present();
      const sid = await session();
      const hook = spawnHook(JSON.stringify(questionInput(sid, questions)), env).done;
      const ask = await waitForAsk(srv.port, sid, 'question');
      await answer(ask.id, { skip: true });
      const r = await hook;
      assert.equal(r.stdout, '');
    });

    it('質問文が 2000 文字を超えるなら盤面に出さず、何も出力しない', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify(questionInput(sid, [{ question: 'q'.repeat(2001), header: 'h', multiSelect: false, options: [] }])), env).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.deepEqual(await asksOf(sid), []);
    });

    it('質問ごとの payload は、選択肢 20 件・見出し 100 文字までに切り詰める', async () => {
      await present();
      const sid = await session();
      const many = [{
        question: 'たくさん選べますか？', header: 'h'.repeat(150), multiSelect: false,
        options: Array.from({ length: 25 }, (_, i) => ({ label: `o${i}`, description: 'd'.repeat(600) })),
      }];
      const hook = spawnHook(JSON.stringify(questionInput(sid, many)), env).done;
      const ask = await waitForAsk(srv.port, sid, 'question');
      assert.equal(ask.payload.questions[0].options.length, 20);
      assert.equal(ask.payload.questions[0].header.length, 100);
      assert.equal(ask.payload.questions[0].options[0].description.length, 500);
      await answer(ask.id, { skip: true });
      await hook;
    });

    // 既知の食い違いの可能性: 契約書は回答を「最大 10 件」と定めるが、hook は 11 件目以降を黙って捨てる。
    // そのため 10 件だけに回答すると、全問回答として 10 件分の answers を返してしまう。
    it('質問が 11 件あるときは盤面に出さず、部分的な answers を返さない', async () => {
      await present();
      const sid = await session();
      const eleven = Array.from({ length: 11 }, (_, i) => ({ question: `Q${i}?`, header: `h${i}`, multiSelect: false, options: [{ label: 'a', description: '' }] }));
      // 盤面に出てしまう実装でも、この hook は回答されないまま短い待ち時間で終わる（テストが止まらないように）
      const h = spawnHook(JSON.stringify(questionInput(sid, eleven)), { ...env, AGENT_VIZ_WAIT_QUESTION_SEC: '2' }).done;
      const shown = await waitForAsk(srv.port, sid, 'question', 1000);
      const r = await h;
      assert.equal(shown, null, '11 件の質問が盤面に出ている（hook が 10 件に切り詰めている）');
      assert.equal(r.stdout, '');
    });

    it('AskUserQuestion 以外の PreToolUse（Bash）は対象外。盤面に出さない', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } }), env).done;
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 3000);
      assert.deepEqual(await asksOf(sid), []);
    });
  });

  describe('Stop（次の指示）', () => {
    it('待機モードがオフのセッションは、待たずに何も出力しない', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify({ hook_event_name: 'Stop', session_id: sid, last_assistant_message: '完了しました' }), env).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 3000);
    });

    it('待機モードがオンなら次の指示を待ち、block と理由（指示の本文）を出力する', async () => {
      await present();
      const sid = await session();
      await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: true } }, { token: srv.token });
      const hook = spawnHook(JSON.stringify({ hook_event_name: 'Stop', session_id: sid, last_assistant_message: '完了しました。次は？' }), env).done;
      const ask = await waitForAsk(srv.port, sid, 'followup');
      assert.ok(ask.payload.last_message.includes('次は'));
      await answer(ask.id, { text: 'テストも追加して' });
      const r = await hook;
      assert.deepEqual(JSON.parse(r.stdout), {
        decision: 'block',
        reason: 'ユーザーが agent-viz の盤面から次の指示を送りました。\n\nテストも追加して',
      });
      await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: false } }, { token: srv.token });
    });

    it('次の指示で skip したら何も出力しない', async () => {
      await present();
      const sid = await session();
      await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: true } }, { token: srv.token });
      const hook = spawnHook(JSON.stringify({ hook_event_name: 'Stop', session_id: sid, last_assistant_message: 'x' }), env).done;
      const ask = await waitForAsk(srv.port, sid, 'followup');
      await answer(ask.id, { skip: true });
      const r = await hook;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
    });

    it('最後の報告は 1000 文字までに切り詰めて盤面に出す', async () => {
      await present();
      const sid = await session();
      await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: true } }, { token: srv.token });
      const hook = spawnHook(JSON.stringify({ hook_event_name: 'Stop', session_id: sid, last_assistant_message: 'x'.repeat(3000) }), env).done;
      const ask = await waitForAsk(srv.port, sid, 'followup');
      assert.equal(ask.payload.last_message.length, 1000);
      await answer(ask.id, { skip: true });
      await hook;
      await postJson(srv.port, '/api/settings', { followup: { session_id: sid, enabled: false } }, { token: srv.token });
    });
  });

  describe('待たない・何も出さない条件', () => {
    it('盤面が見えていない（presence が無い）なら、待たずに何も出力しない', async () => {
      await present(false);
      const sid = await session();
      const r = await spawnHook(JSON.stringify(permInput(sid)), env).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 3000, 'サーバーで待ったらしい');
      assert.deepEqual(await asksOf(sid), []);
      await present(true);
    });

    it('盤面に出ていないセッションなら、待たずに何も出力しない', async () => {
      await present();
      const r = await spawnHook(JSON.stringify(permInput('not-on-board')), env).done;
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 3000);
    });

    it('「盤面で回答する」がオフなら、見えていても待たない', async () => {
      await present();
      const sid = await session();
      await postJson(srv.port, '/api/settings', { answerEnabled: false }, { token: srv.token });
      try {
        const r = await spawnHook(JSON.stringify(permInput(sid)), env).done;
        assert.equal(r.stdout, '');
        assert.ok(r.ms < 3000);
        assert.deepEqual(await asksOf(sid), []);
      } finally {
        await postJson(srv.port, '/api/settings', { answerEnabled: true }, { token: srv.token });
      }
    });

    it('AGENT_VIZ_DISABLE=1 なら、サーバーへ送らず何も出力しない', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify(permInput(sid)), { ...env, AGENT_VIZ_DISABLE: '1' }).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 3000);
      assert.deepEqual(await asksOf(sid), []);
    });

    it('標準入力が JSON でない・空・オブジェクトでない・session_id が無いなら、何も出力せず exit 0', async () => {
      const inputs = ['not json', '', '[]', JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })];
      for (const text of inputs) {
        const r = await spawnHook(text, env).done;
        assert.equal(r.stdout, '', JSON.stringify(text));
        assert.equal(r.code, 0, JSON.stringify(text));
      }
    });

    it('時間切れ（AGENT_VIZ_WAIT_PERMISSION_SEC）なら、何も出力せず exit 0。盤面からも消える', async () => {
      await present();
      const sid = await session();
      const r = await spawnHook(JSON.stringify(permInput(sid)), { ...env, AGENT_VIZ_WAIT_PERMISSION_SEC: '1' }).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms >= 900 && r.ms < 5000, `elapsed ${r.ms}`);
      assert.deepEqual(await asksOf(sid), []);
    });

    it('hook が途中で殺されると、盤面の ask は取り下げられる', async () => {
      await present();
      const sid = await session();
      const h = spawnHook(JSON.stringify(permInput(sid)), env);
      const ask = await waitForAsk(srv.port, sid, 'permission');
      assert.ok(ask, 'ask が盤面に出ない');
      h.child.kill('SIGKILL');
      await h.done;
      const gone = await waitFor(async () => (await asksOf(sid)).length === 0, { timeout: 3000 });
      assert.ok(gone, 'hook が死んだのに ask が残っている');
    });
  });
});

describe('bin/ask.mjs: 起動できない・トークンが無い場合', () => {
  it('サーバーが無い（トークンはあるが、ポートで待つ者がいない）なら、何も出力せず exit 0', async () => {
    const home = makeTempHome();
    try {
      const port = await freePort();
      fs.mkdirSync(path.join(home, '.agent-viz'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(home, '.agent-viz', `token-${port}`), 'c'.repeat(48) + '\n', { mode: 0o600 });
      const r = await spawnHook(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: {} }), childEnv(home, { AGENT_VIZ_PORT: String(port) })).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 5000);
    } finally {
      removeDir(home);
    }
  });

  it('トークンが読めないなら、サーバーへ送らず何も出力しない（見えていても待たない）', async () => {
    const srv = await startServer({ env: { AGENT_VIZ_WAIT_PERMISSION_SEC: '60' } });
    const other = makeTempHome();
    try {
      await setPresence(srv.port, srv.token, true, 'no-token-test');
      await registerSession(srv.port, 'no-token-session');
      const r = await spawnHook(
        JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'no-token-session', tool_name: 'Bash', tool_input: {} }),
        childEnv(other, { AGENT_VIZ_PORT: String(srv.port), AGENT_VIZ_WAIT_PERMISSION_SEC: '60' }),
      ).done;
      assert.equal(r.stdout, '');
      assert.equal(r.code, 0);
      assert.ok(r.ms < 5000, `送って待ったらしい（${r.ms} ms）`);
      const st = await getState(srv.port);
      assert.equal(st.sessions.find((s) => s.id === 'no-token-session').asks.length, 0);
    } finally {
      removeDir(other);
      await stopServer(srv);
    }
  });
});
