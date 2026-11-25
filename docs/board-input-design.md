# 盤面からの入力（許可・質問・次の指示）設計

ブランチ: `feat/board-input`　状態: 実装済み（ブラウザと実際の hook を使った通しの確認済み。許可・質問・次の指示の3経路）

## 目的

agent-viz の盤面から、端末に戻らずに次の3つへ答えられるようにする。

1. **許可**: 許可ダイアログ（`PermissionRequest`）の 許可 / 拒否
2. **質問**: `AskUserQuestion`（選択式の質問）への回答
3. **次の指示**: 統括が止まったときに送る次の指示（「待機モード」をオンにしたセッションだけ）

## 非目標

- 常時チャット（Remote Control と役割が重なる）
- Channels（research preview・起動フラグ必須のため今回は見送り）
- 「以後も許可」(`updatedPermissions`) の自動付与
- 回答履歴の永続化

## 原則

1. **fail-open**: 盤面が開いていない・サーバーが落ちている・時間切れ・何かのエラー、のどれでも、hook は何も出力せず exit 0 で終わる。その場合は従来どおり端末のダイアログに戻る。
2. 既存の `bin/hook.mjs`（常に無出力 exit 0）は変更しない。待つ処理は `bin/ask.mjs` に分ける。
3. 依存ゼロ・Node 18 以上。
4. 盤面に出す文字列（ツール入力・質問文・報告）は外部の指示注入で攻撃者が決め得る。描画は `textContent` / `createElement` のみ。`innerHTML` に差し込まない。

## 全体像

```
Claude Code ──hook(待つ)──▶ bin/ask.mjs ──POST /api/ask (長時間待ち)──▶ server
ブラウザ ──POST /api/answer──▶ server ──(200 + answer)──▶ ask.mjs ──hook 出力──▶ Claude Code
```

- 待つ側（ask.mjs）の接続が切れたら（端末側で答えた・時間切れ・hook が殺された）、サーバーは該当の ask を即座に取り下げる。
- 待つのは、次をすべて満たすときだけ（`AskStore.canWait`）。満たさなければ即 204（= 何もしない）。
  - 設定 `answerEnabled` が true
  - 直近 25 秒以内に「見えているタブ」から presence が届いている
  - 種別が followup の場合、そのセッションの待機モードがオン

## ファイル

| ファイル | 内容 | 担当 |
|---|---|---|
| `server/auth.mjs` | トークン保管、Host/Origin/Sec-Fetch-Site 検証 | 実装済み（Sonnet） |
| `server/asks.mjs` | `AskStore`（待ち合わせ・presence・回答の検証） | 実装済み（Sonnet） |
| `server/server.mjs` | エンドポイントの配線、スナップショットへの追加 | Haiku |
| `bin/ask.mjs` | 待つ hook。入出力の変換 | Haiku |
| `hooks/hooks.json` | hook の追加 | Haiku |
| `server/public/index.html` | UI | Haiku |
| `test/*.test.mjs` | `node --test` のテスト | Haiku |
| `README.md` | 使い方・設定・セキュリティの追記 | Haiku |

## 認証（`server/auth.mjs`）

- トークン: 48 桁 hex。サーバー初回起動時に生成し、`~/.agent-viz/token-<PORT>`（ディレクトリ 0700・ファイル 0600）に保存。書けなければ `$TMPDIR/agent-viz-<uid>/`（所有者と権限を検証）。どちらも不可ならメモリ上のみ（その場合 hook は読めず、回答機能は使えないが表示は動く）。
- 検証:
  - すべてのリクエスト: `Host` が `localhost:<PORT>` / `127.0.0.1:<PORT>` / `[::1]:<PORT>` / `AGENT_VIZ_ALLOWED_HOSTS`（カンマ区切り）のいずれか（DNS リバインディング対策）。`Origin` があれば同じ集合に含まれること。`Sec-Fetch-Site` があれば `same-origin` か `none` のみ。
  - 書き込み系 `/api/ask` `/api/answer` `/api/presence` `/api/settings` `/api/clear`: 上記に加えて `x-agent-viz-token` ヘッダが一致（`timingSafeEqual`）。
  - `/event`（既存の hook 用）: トークンは不要（互換のため）。ただし `content-type: application/json` 必須（415）、Host/Origin 検証あり。回答の権限は持たない。
- ページへのトークン埋め込み: `GET /` は `<meta name="agent-viz-token" content="...">` を `</head>` の直前に差し込む。差し込む条件は次のいずれか（`mayReceiveToken`）。
  1. `?key=<token>` が一致する。
  2. 接続元がループバックで、かつ **接続元ソケットの所有者 UID が、サーバーを動かしている自分の UID と一致する**（Linux のみ。`/proc/net/tcp{,6}` から調べる）。同じマシンの別ユーザーが `127.0.0.1` に接続しても、トークンは渡らない。
  3. UID を確認できない環境（macOS・Windows）では、`AGENT_VIZ_TRUST_LOOPBACK=1` のときだけ、ループバックからの接続に渡す。未設定なら 1 だけが有効（`?key=` が必要）。
  - `AGENT_VIZ_STRICT_KEY=1` のときは 1 だけを有効にする。
- `0.0.0.0` で待ち受けても、トークンは上の条件を満たす人にしか渡らない。
- 読み手の区別: `/stream` と `/api/state` は、ask の中身（コマンド・質問文など）を **トークンを持つ読み手にだけ**返す（`readerTrusted`）。トークンを持つとは、`x-agent-viz-token` ヘッダ、または `?key=` が一致する、またはページにトークンを渡せる相手（上の 1〜3）と同じ条件を満たすこと。持たない読み手には `asks: []` にしたスナップショットを返す。ページは、トークンがあれば `stream?key=<token>` で接続する。
- 既知の限界: 回答の権限と ask の中身は守るが、それ以外の盤面の表示（依頼文・報告・進捗）は今までどおり、同じマシンの他のユーザーからも読める。複数ユーザーのマシンでは注意。`/event` は互換のためトークン不要のまま（偽のイベントで表示を乱せるが、回答の権限は持たない。ask を取り下げられても、端末の従来の動作に戻るだけ）。
- `peerUid` はクライアントのアドレス:ポートとサーバーのアドレス:ポートの 4 つ組と、接続状態（ESTABLISHED）で照合する。ポートだけで照合すると、別のアドレス族の他人の接続（`::1` と `127.0.0.1` など）と取り違える。
- ページは `x-frame-options: DENY` と `content-security-policy: frame-ancestors 'none'` を返し、他サイトに埋め込まれてボタンを誤クリックさせられるのを防ぐ。
- 他サイトのリンクから開く場合（`GET` で `sec-fetch-mode: navigate`・`sec-fetch-dest: document`）は、`sec-fetch-site: cross-site` でも許可する（結果は相手のページから読めない）。fetch の cross-site は拒否。
- `AGENT_VIZ_HOST` が `0.0.0.0` / `::` 以外のときは、`HOST:PORT` も許可する Host に自動で加える（`hook.mjs` が送る Host を通すため）。

## エンドポイント

共通: 認証に失敗したら `403`（Host/Origin）または `401`（トークン）。本文は JSON、上限 64KB（超えたら 413）。

### `POST /api/ask`（hook → サーバー）

```json
{ "kind": "permission|question|followup", "session_id": "...", "payload": {...}, "wait_ms": 120000 }
```

- `canWait` が false、または盤面にまだ現れていない `session_id`（`/event` で一度も受けていない）→ `204`（即時）。誰にも見えない ask のために hook を待たせないため。
- 待ち合わせ中に回答が来る → `200 {"answer": {...}}`（`validateAnswer` で正規化済み）
- 時間切れ（`wait_ms`、1000〜900000 にクランプ）→ `204`
- リクエスト接続が先に切れた → ask を取り下げる
- 未処理の ask が 50 件を超えたら `429`

`payload`（hook が作る。クリップ済み）:

- `permission`: `{ tool_name, summary, input_preview }`。`input_preview` は `JSON.stringify(tool_input)` の**全文**。`summary` は判断に効く引数（コマンド・パス・URL など）を先頭に省略せず入れ、`description` は「（Claude の説明・未検証）」を添えて後ろに置く。**入力が 6000 文字を超えるときは ask を出さず、何も出力しない**（切り詰めると見えない部分を許可することになるため。端末で判断してもらう）。UI は要約と入力の全文の両方を表示する。
- `question`: `{ questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`
- `followup`: `{ last_message }`（最大1000文字）

### `POST /api/answer`（ブラウザ → サーバー）

```json
{ "id": "<ask id>", "answer": {...} }
```

回答の形（`validateAnswer` が正規化）:

- 共通: `{ "skip": true }` = 「端末で答える」。hook は何も出力しない。
- `permission`: `{ "behavior": "allow" | "deny", "message": "任意(最大500)" }`
- `question`: `{ "answers": { "<質問文>": "<選んだlabel / 複数はカンマ区切り / その他の自由入力>" } }`（質問は最大10件、各値は最大2000文字）
- `followup`: `{ "text": "次の指示(1〜20000文字)" }`

`200 {"ok":true}`。未処理でなければ（回答済み・取り下げ済み）`404`。

### `POST /api/presence`

`{ "client": "<64文字以内>", "visible": true }`。ブラウザは 10 秒ごと、および `visibilitychange` で送る。25 秒で失効。

### `POST /api/settings`

`{ "answerEnabled": true }` または `{ "followup": { "session_id": "...", "enabled": true } }`。

### スナップショット（`/stream`, `/api/state`）への追加

```
{ now, settings: { answerEnabled, watching }, sessions: [{ ..., followup: bool,
  asks: [{ id, kind, payload, createdAt, expiresAt }] }] }
```

トークンは含めない。セッション終了（`SessionEnd`）と 12 時間 TTL での削除時は、そのセッションの ask と待機モードを破棄する。

## hook（`bin/ask.mjs`）

| hook | matcher | 種別 | タイムアウト（hooks.json） | 待ち時間の既定（環境変数） |
|---|---|---|---|---|
| `PermissionRequest` | `*` | permission | 150 | 120 秒（`AGENT_VIZ_WAIT_PERMISSION_SEC`） |
| `PreToolUse` | `AskUserQuestion` | question | 330 | 300 秒（`AGENT_VIZ_WAIT_QUESTION_SEC`） |
| `Stop` | なし | followup | 650 | 600 秒（`AGENT_VIZ_WAIT_FOLLOWUP_SEC`） |

既存の `hook.mjs` の hook 定義はそのまま残す（同じイベントに hook を追加する）。

`ask.mjs` の動作:

1. `AGENT_VIZ_DISABLE=1` なら何もしない。標準入力の JSON を読む。
2. `readToken(PORT)` でトークンを読む。無ければ何もしない。サーバーは自動起動しない（それは `hook.mjs` の役割）。
3. 種別を決めて `payload` を作り、`POST /api/ask` に `AbortSignal.timeout(wait_ms + 5000)` で送る。`PermissionRequest` で `tool_name` が `AskUserQuestion` のときは何もしない。
4. 200 以外・例外・不正な回答はすべて「何も出力せず exit 0」。
5. 200 のときの出力:
   - permission 許可: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   - permission 拒否: 同じ形で `"behavior":"deny","message":"<message か 盤面で拒否されました>"`
   - question: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...tool_input, "answers": {...}}}}`。すべての質問に回答があること。無ければ何も出力しない。
   - followup: `{"decision":"block","reason":"ユーザーが agent-viz の盤面から次の指示を送りました。\n\n<text>"}`
   - `skip` は何も出力しない。

## UI（`index.html`）

- ヘッダー: 「盤面で回答する」スイッチ（`answerEnabled`）。回答できる状態か（`watching`）の表示。タブのタイトルに未回答の件数を `(n) ` で付ける。
- presence を 10 秒ごと・`visibilitychange` で送る。
- 統括カードに、そのセッションの `asks` を出す。
  - permission: ツール名、`summary`（`<pre>`）、[許可][拒否][端末で判断]
  - question: 質問ごとに見出しチップ、選択肢（単一はラジオ、`multiSelect` はチェック。`description` は小さく）、「その他」の自由入力。全問に回答するまで [送信] は無効。[端末で答える]
  - followup: テキストエリア、[送信]、[待機をやめる]（= skip）
- 各セッションのカードに「次の指示を待つ」のスイッチ（`followup`）。説明文を添える（オンの間、統括が止まるたびに最大 10 分待つ）。
- 残り時間（`expiresAt`）を表示。回答後はボタンを無効化。`404` は「端末か別のタブで回答済みです」と表示。
- トークンは `<meta name="agent-viz-token">` から読み、`x-agent-viz-token` ヘッダで送る。無い場合は、回答ボタンを無効にして「localhost で開くか `?key=` を付けてください」と出す。
- 既存の見た目（ダークモード・スマホ幅）と揃える。キーボード操作とフォーカスに配慮する。

## 設定（環境変数の追加分）

| 変数 | 既定 | 内容 |
|---|---|---|
| `AGENT_VIZ_ALLOWED_HOSTS` | なし | 許可する Host（カンマ区切り。例 `myhost:4777`） |
| `AGENT_VIZ_STRICT_KEY` | なし | `1` でトークンを `?key=` の人にだけ渡す（UID の確認もしない） |
| `AGENT_VIZ_TRUST_LOOPBACK` | なし | `1` で、UID を確認できない環境（macOS・Windows）でもループバックからの接続にトークンを渡す。1 ユーザーのマシン向け |
| `AGENT_VIZ_WAIT_PERMISSION_SEC` / `_QUESTION_SEC` / `_FOLLOWUP_SEC` | 120 / 300 / 600 | 盤面の回答を待つ上限 |

## 既知の未確認事項（README にも書く）

- `PermissionRequest` hook が端末のダイアログと同時に動くのか、先に待つのかは確認できていない。先に待つ場合、盤面のタブが見えている間は端末の許可が最大で待ち時間ぶん遅れる。その場合は「盤面で回答する」をオフにするか、待ち時間を短くする。
- `AskUserQuestion` の複数選択の回答形式（カンマ区切り）は、公式ドキュメントに明記がなく、実機での確認が必要。
