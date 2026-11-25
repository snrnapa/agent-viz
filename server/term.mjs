// tmux を使った端末の管理。依存ゼロ（tmux 3.0 以上が必要）。
// 専用ソケット（-L agent-viz-<port>）を使い、利用者の普段の tmux とは分ける。
// 画面への中継は tmux の制御モード（-C）で行うので、PTY ライブラリは要らない。
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME_RE = /^av-[0-9a-f]{8}$/;
// 起動できるコマンドは固定。ブラウザから任意のコマンド文字列は受け取らない
export const MODES = { claude: 'claude', continue: 'claude --continue', shell: '' };
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// claude には、このサーバー自身をプラグインとして読み込ませる。インストール版が古いと hook が端末名を送らず、
// 一覧で端末とセッションが 2 行に分かれるため。同名のインストール版より --plugin-dir が優先され、hook は二重にならない
export function launchCommand(mode, pluginDir = PLUGIN_DIR) {
  return MODES[mode] ? `${MODES[mode]} --plugin-dir ${shellQuote(pluginDir)}` : '';
}
const SCROLLBACK = 2000;
const INPUT_CHUNK = 256;

const clamp = (v, min, max, def) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : def);
export const clampSize = (cols, rows) => ({ cols: clamp(cols, 20, 500, 100), rows: clamp(rows, 5, 200, 30) });

// このサーバーは Claude Code の hook から起動されるので、親セッションの環境変数が残っている。
// そのまま渡すと、新しい claude が「子セッション」として振る舞うため取り除く。
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PLUGIN_|CLAUDE_PROJECT_|CLAUDE_ENV_|AI_AGENT$|TMUX|AGENT_VIZ_TERM$)/.test(k)) continue;
    out[k] = v;
  }
  if (!/utf-?8/i.test(out.LC_ALL || out.LC_CTYPE || out.LANG || '')) out.LC_CTYPE = 'C.UTF-8';
  return out;
}

// 制御モードの %output は、制御文字とバックスラッシュが \ooo（8進）になっている。バイト列に戻す
export function decodeOutput(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x5c && i + 3 < buf.length) {
      const oct = buf.toString('latin1', i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) { out[n++] = parseInt(oct, 8); i += 3; continue; }
    }
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

export function createTerminals({ port, socket = `agent-viz-${port}` }) {
  const base = ['-L', socket, '-f', '/dev/null', '-u'];

  const tmux = (...args) => new Promise((resolve, reject) => {
    execFile('tmux', [...base, ...args], { env: cleanEnv(), timeout: 5000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr); reject(err); } else resolve(String(stdout));
    });
  });

  async function available() {
    try { await tmux('-V'); return true; } catch { return false; }
  }

  async function list() {
    let text;
    try {
      text = await tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_command}\t#{pane_current_path}');
    } catch { return []; } // tmux サーバーが無い = 端末が無い
    return text.split('\n').filter(Boolean).map((l) => {
      const [name, created, command, ...cwd] = l.split('\t');
      return { name, createdAt: Number(created) * 1000, command, cwd: cwd.join('\t') };
    }).filter((t) => NAME_RE.test(t.name));
  }

  async function create({ cwd, mode = 'claude' }) {
    if (!Object.hasOwn(MODES, mode)) throw new Error('invalid mode');
    // tmux は -c の値を書式（#...）として展開するので、「#」を含むパスは tmux に渡さない
    if (typeof cwd === 'string' && cwd.includes('#')) {
      throw new Error('パスに「#」を含むディレクトリでは起動できません（tmux が書式として解釈するため）');
    }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('cwd must be an existing absolute directory');
    }
    const name = `av-${crypto.randomBytes(4).toString('hex')}`;
    // 利用者の既定シェルを開いてからコマンドを打ち込む（PATH が普段どおりになり、claude 終了後もシェルが残る）
    await tmux('new-session', '-d', '-s', name, '-c', cwd, '-x', '100', '-y', '30',
      '-e', `AGENT_VIZ_TERM=${name}`, '-e', `AGENT_VIZ_PORT=${port}`);
    await tmux('set-option', '-t', `=${name}:`, 'status', 'off');
    const command = launchCommand(mode);
    if (command) {
      await tmux('send-keys', '-t', `=${name}:`, '-l', command);
      await tmux('send-keys', '-t', `=${name}:`, 'Enter');
    }
    return { name };
  }

  async function kill(name) {
    if (!NAME_RE.test(name)) return false;
    try { await tmux('kill-session', '-t', `=${name}`); return true; } catch { return false; }
  }

  /**
   * 端末に接続する。最初に今の画面（と直近の履歴）を onData に渡し、以後は出力を流す。
   * @returns {{ write(buf: Buffer): void, resize(cols:number, rows:number): void, close(): void }}
   */
  function attach(name, { cols, rows, onData, onExit }) {
    if (!NAME_RE.test(name)) throw new Error('invalid name');
    const child = spawn('tmux', [...base, '-C', 'attach-session', '-t', `=${name}`], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let pane = null; // 画面を送り終えるまで null（それまでの %output は捨てる。画面の取得に含まれるため）
    let closed = false;
    let rest = Buffer.alloc(0);
    let block = null; // %begin〜%end の中身
    const waiting = []; // 自分が送ったコマンドの応答待ち（送った順に返る）

    const send = (cmd, cb = null) => {
      if (closed || !child.stdin.writable) return;
      waiting.push(cb);
      child.stdin.write(cmd + '\n');
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      child.kill();
      onExit?.();
    };

    function onLine(line) {
      if (block) {
        const head = line.toString('latin1', 0, 64);
        const m = /^%(end|error) \d+ (\d+) /.exec(head);
        if (m && m[2] === block.num) {
          const { lines, ours } = block;
          block = null;
          if (ours) waiting.shift()?.(lines, m[1] === 'error');
        } else block.lines.push(Buffer.from(line));
        return;
      }
      const head = line.toString('latin1', 0, 64);
      const begin = /^%begin \d+ (\d+) (\d+)/.exec(head);
      if (begin) { block = { num: begin[1], ours: begin[2] === '1', lines: [] }; return; }
      if (head.startsWith('%output ')) {
        const sp = line.indexOf(0x20, 8);
        if (pane && sp > 0 && line.toString('latin1', 8, sp) === pane) onData(decodeOutput(line.subarray(sp + 1)));
        return;
      }
      if (head.startsWith('%exit')) finish();
    }

    child.stdout.on('data', (chunk) => {
      rest = Buffer.concat([rest, chunk]);
      let i;
      while (!closed && (i = rest.indexOf(0x0a)) >= 0) {
        onLine(rest.subarray(0, i));
        rest = rest.subarray(i + 1);
      }
      if (rest.length > 4e6) finish();
    });
    child.stdin.on('error', () => {});
    child.on('error', finish);
    child.on('close', finish);

    const size = clampSize(cols, rows);
    send(`refresh-client -C ${size.cols}x${size.rows}`);
    let info = null;
    send(`display-message -p -t =${name}: "#{pane_id} #{cursor_x} #{cursor_y}"`, (lines, failed) => {
      if (!failed) info = String(lines[0] || '').split(' ');
    });
    send(`capture-pane -p -e -S -${SCROLLBACK} -t =${name}:`, (lines, failed) => {
      if (failed || !info) return finish();
      const [id, x, y] = info;
      const screen = Buffer.concat(lines.flatMap((l, i) => (i ? [Buffer.from('\r\n'), l] : [l])));
      onData(Buffer.concat([Buffer.from('\x1bc'), screen, Buffer.from(`\x1b[0m\x1b[${Number(y) + 1};${Number(x) + 1}H`)]));
      pane = id;
    });

    return {
      write(buf) {
        if (!pane) return;
        for (let i = 0; i < buf.length; i += INPUT_CHUNK) {
          const hex = [...buf.subarray(i, i + INPUT_CHUNK)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          send(`send-keys -t ${pane} -H ${hex}`);
        }
      },
      resize(c, r) {
        const s = clampSize(c, r);
        send(`refresh-client -C ${s.cols}x${s.rows}`);
      },
      close: finish,
    };
  }

  return { socket, available, list, create, kill, attach };
}
