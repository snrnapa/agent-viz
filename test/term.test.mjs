// server/term.mjs の単体テスト。実 tmux は mode "shell" だけで起動する（claude は絶対に起動しない）。
// tmux が無い環境では実 tmux の部分を skip する。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanEnv, clampSize, createTerminals, decodeOutput, launchCommand, NAME_RE } from '../server/term.mjs';
import { sleep, waitFor } from './helpers.mjs';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe('decodeOutput: 制御モードの8進エスケープを戻す', () => {
  it('\\ooo を1バイトに戻す（ESC や バックスラッシュ）', () => {
    const out = decodeOutput(Buffer.from('\\033[31mred\\134end'));
    assert.equal(out.toString('latin1'), '\x1b[31mred\\end');
  });

  it('バックスラッシュに続く3桁が8進でなければそのまま残す', () => {
    assert.equal(decodeOutput(Buffer.from('a\\zzzb')).toString('latin1'), 'a\\zzzb');
    assert.equal(decodeOutput(Buffer.from('x\\8')).toString('latin1'), 'x\\8');
  });

  it('UTF-8 の日本語（バイト列のまま）は壊さない', () => {
    const src = Buffer.from('日本語\\015\\012');
    assert.equal(decodeOutput(src).toString('utf8'), '日本語\r\n');
  });
});

describe('cleanEnv: 親セッションの環境変数を取り除く', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'ja_JP.UTF-8',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '123',
    CLAUDE_PLUGIN_ROOT: '/p',
    CLAUDE_PROJECT_DIR: '/d',
    CLAUDE_ENV_FILE: '/e',
    AI_AGENT: 'x',
    TMUX: '/tmp/tmux-1000/default,1,0',
    TMUX_PANE: '%1',
    AGENT_VIZ_TERM: 'av-00000000',
    AGENT_VIZ_PORT: '4777',
    CLAUDE_CONFIG_DIR: '/c',
  };

  it('CLAUDECODE・CLAUDE_CODE_*・CLAUDE_PLUGIN_*・TMUX・AGENT_VIZ_TERM を除き、他は残す', () => {
    const out = cleanEnv(env);
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR',
      'CLAUDE_ENV_FILE', 'AI_AGENT', 'TMUX', 'TMUX_PANE', 'AGENT_VIZ_TERM']) {
      assert.equal(k in out, false, `${k} は残らない`);
    }
    assert.equal(out.PATH, '/usr/bin');
    assert.equal(out.HOME, '/home/u');
    assert.equal(out.AGENT_VIZ_PORT, '4777');
    assert.equal(out.CLAUDE_CONFIG_DIR, '/c');
  });

  it('UTF-8 のロケールが無いときは LC_CTYPE=C.UTF-8 を足す', () => {
    assert.equal(cleanEnv({ PATH: '/usr/bin' }).LC_CTYPE, 'C.UTF-8');
    assert.equal(cleanEnv({ LANG: 'C' }).LC_CTYPE, 'C.UTF-8');
  });

  it('UTF-8 のロケールがあれば LC_CTYPE は足さない', () => {
    assert.equal('LC_CTYPE' in cleanEnv({ LANG: 'ja_JP.UTF-8' }), false);
    assert.equal('LC_CTYPE' in cleanEnv({ LC_ALL: 'en_US.utf8' }), false);
  });

  it('元の env オブジェクトを書き換えない', () => {
    const copy = { ...env };
    cleanEnv(env);
    assert.deepEqual(env, copy);
  });
});

describe('clampSize: 端末サイズを範囲に収める', () => {
  it('既定値は 100x30', () => {
    assert.deepEqual(clampSize(undefined, undefined), { cols: 100, rows: 30 });
  });

  it('範囲内の値はそのまま、範囲外は端に寄せる', () => {
    assert.deepEqual(clampSize(80, 24), { cols: 80, rows: 24 });
    assert.deepEqual(clampSize(10, 1000), { cols: 20, rows: 200 });
    assert.deepEqual(clampSize(1000, 3), { cols: 500, rows: 5 });
  });

  it('整数でない値は既定値にする', () => {
    assert.deepEqual(clampSize('80', 24.5), { cols: 100, rows: 30 });
    assert.deepEqual(clampSize(NaN, null), { cols: 100, rows: 30 });
  });
});

describe('createTerminals: create の入力検証（tmux を呼ぶ前に弾く）', () => {
  const term = createTerminals({ port: 1, socket: `agent-viz-test-unused-${crypto.randomBytes(4).toString('hex')}` });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viz-term-'));
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('mode が不正なら拒否する（任意のコマンド文字列は受け付けない）', async () => {
    await assert.rejects(term.create({ cwd: dir, mode: 'rm -rf /' }), /invalid mode/);
    await assert.rejects(term.create({ cwd: dir, mode: 'toString' }), /invalid mode/);
  });

  it('cwd が相対パス・存在しない・ディレクトリでなければ拒否する', async () => {
    await assert.rejects(term.create({ cwd: 'relative/dir', mode: 'shell' }), /cwd must be/);
    await assert.rejects(term.create({ cwd: path.join(dir, 'nope'), mode: 'shell' }), /cwd must be/);
    await assert.rejects(term.create({ cwd: file, mode: 'shell' }), /cwd must be/);
    await assert.rejects(term.create({ cwd: undefined, mode: 'shell' }), /cwd must be/);
  });

  it('attach の名前が形式に合わなければ例外', () => {
    assert.throws(() => term.attach('../evil', { cols: 80, rows: 24, onData() {} }), /invalid name/);
  });

  it('kill は形式に合わない名前を false で返す（tmux を呼ばない）', async () => {
    assert.equal(await term.kill('x; rm -rf /'), false);
    assert.equal(NAME_RE.test('av-0123abcd'), true);
    assert.equal(NAME_RE.test('av-0123abc'), false);
  });
});

describe('実 tmux: 起動 → attach → 入力と出力 → resize → kill → onExit', { skip: !hasTmux && 'tmux が無いのでskip' }, () => {
  const socket = `agent-viz-test-${crypto.randomBytes(6).toString('hex')}`;
  const term = createTerminals({ port: 1, socket });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viz-term-'));
  let savedShell;

  before(() => {
    // 利用者の rc ファイルを読まない固定のシェルにする
    savedShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
  });
  after(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    if (savedShell === undefined) delete process.env.SHELL; else process.env.SHELL = savedShell;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shell で起動し、一覧に出て、日本語の入出力・resize・kill ができる', async () => {
    const { name } = await term.create({ cwd: dir, mode: 'shell' });
    assert.match(name, NAME_RE);

    const listed = await term.list();
    assert.ok(listed.some((t) => t.name === name), '一覧に出る');
    assert.equal(listed.find((t) => t.name === name).cwd, dir);

    let got = Buffer.alloc(0);
    let exited = false;
    const view = term.attach(name, {
      cols: 90,
      rows: 20,
      onData: (buf) => { got = Buffer.concat([got, buf]); },
      onExit: () => { exited = true; },
    });

    // 最初に今の画面が届く（ESC c で始まる）
    await waitFor(() => got.length > 0, { timeout: 5000 });
    assert.equal(got.subarray(0, 2).toString('latin1'), '\x1bc');

    // 日本語を含む入力。printf の結果（ja-日本語）は、入力の行そのものには現れない
    view.write(Buffer.from('printf "ja-%s\\n" 日本語\n', 'utf8'));
    const seen = await waitFor(() => got.toString('utf8').includes('ja-日本語'), { timeout: 8000 });
    assert.ok(seen, '日本語の出力が届く');

    view.resize(120, 40);
    const size = await waitFor(() => {
      // 制御クライアントは高さを報告しないので、ウィンドウの大きさで確かめる
      const r = spawnSync('tmux', ['-L', socket, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}'], { encoding: 'utf8' });
      return r.stdout.trim() === '120x40' ? true : null;
    }, { timeout: 3000 });
    assert.ok(size, 'resize 後のウィンドウ幅・高さが 120x40');

    assert.equal(await term.kill(name), true);
    await waitFor(() => exited, { timeout: 5000 });
    assert.equal(exited, true, '終了で onExit が呼ばれる');
    const after = await term.list();
    assert.equal(after.some((t) => t.name === name), false, '一覧から消える');
    assert.equal(await term.kill(name), false, '既に無いものは false');
  });

  it('close() は onExit を呼ぶ（接続だけ閉じ、端末は残す）', async () => {
    const { name } = await term.create({ cwd: dir, mode: 'shell' });
    let exited = false;
    const view = term.attach(name, { cols: 80, rows: 24, onData() {}, onExit: () => { exited = true; } });
    await sleep(300);
    view.close();
    assert.equal(exited, true);
    assert.ok((await term.list()).some((t) => t.name === name), '端末そのものは残る');
    await term.kill(name);
  });
});

describe('起動コマンド', () => {
  // シェルに打ち込む文字列なので、本物のシェルに解釈させて引数を確かめる（claude は起動しない）
  const argsOf = (command) => execFileSync('sh', ['-c', `claude() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' }).split('\n').slice(0, -1);

  it('claude と continue は、このアプリ自身をプラグインとして読み込ませる（hook の版をサーバーと揃える）', () => {
    assert.deepEqual(argsOf(launchCommand('claude', '/opt/agent-viz')), ['--plugin-dir', '/opt/agent-viz']);
    assert.deepEqual(argsOf(launchCommand('continue', '/opt/agent-viz')), ['--continue', '--plugin-dir', '/opt/agent-viz']);
  });

  it('空白・引用符・シェルの記号を含むパスも、1 つの引数のまま渡る', () => {
    const dir = "/tmp/my plugins/it's $HOME `id`; x";
    assert.deepEqual(argsOf(launchCommand('claude', dir)), ['--plugin-dir', dir]);
  });

  it('shell は何も打ち込まない', () => {
    assert.equal(launchCommand('shell', '/opt/agent-viz'), '');
  });
});
