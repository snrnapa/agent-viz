# ワークスペース画面（起動・端末・プレビュー）設計

## 目的
複数ディレクトリで動く Claude Code を、ターミナルを移動せずに1画面で一覧・操作し、作られた画像や Markdown も見られるようにする。

## 非目標
独自のチャット UI、画面起動でないセッションの操作（一覧と閲覧のみ）、画像の貼り付け、Windows 対応、ループバック以外からの端末操作。

## 方式
`tmux`（専用ソケット `agent-viz-<port>`）で起動し、制御モードで中継する（`server/term.mjs`）。表示は同梱した xterm.js。API は `server/workspace.mjs`。サーバーを再起動しても端末は残り、`tmux -L agent-viz-<port> attach -t <name>` で手元からも開ける。

画面から起動した端末のセッション（`session.term` あり）では、許可と質問の ask は待たずに 204 を返し、端末にそのまま出す（`followup` は従来どおり）。

## 安全策
端末とファイルの API は、ループバック接続かつトークン必須（POST はヘッダのみ）。起動コマンドは `claude` / `claude --continue` / シェルのみ。`claude` の 2 つには、サーバーが自分のフォルダを `--plugin-dir`（シェル向けに引用）で付ける。hook の版をサーバーと揃え、端末とセッションが一覧で 2 行に分かれるのを防ぐため（2.1.332 で、インストール版より優先され hook が二重にならないことを確認）。親セッションの `CLAUDE*` 環境変数は引き継がない。プレビューは hook が記録したパスと拡張子だけ。`AGENT_VIZ_TERMINAL=0` で端末を無効化。

## API（トークンは `x-agent-viz-token` ヘッダ。GET は `?key=` も可）
- `GET /api/term` → `{ available, socket, modes: ["claude","continue","shell"], terms: [{ name, createdAt, command, cwd }] }`
- `GET /api/term/dirs?prefix=` → `{ dirs }`（続くディレクトリの候補。末尾 `/`。`~` 対応。隠しディレクトリは `.` を打ったときだけ。最大200）
- `POST /api/term/create` `{ cwd(絶対パス), mode }` → `{ name }` / 400 `{ error }`
- `POST /api/term/kill` `{ name }` → 200 / 404
- `GET /api/term/stream?name=&cols=&rows=&key=` → SSE。最初に `event: attached` `{ id }`。以後の `message` の data は出力バイト列の base64。終了時 `event: exit`（受けたら EventSource を close する）。再接続のたびに画面全体が先頭の `ESC c` 付きで送り直される
- `POST /api/term/input` `{ id, data: base64(UTF-8) }` → 204。**順序を守るため、送信は直列にする**
- `POST /api/term/resize` `{ id, cols, rows }` → 204
- `GET /api/file?session=<id>&path=<絶対パス>&key=` → ファイル本体（画像はそのまま、md/txt は text/plain）

## スナップショット（`/stream?key=`）の追加
`sessions[].title`（セッション名。付いているときだけ）、`sessions[].term`（端末名。画面から起動したセッションのみ）、`sessions[].files: [{ path, t, tool }]`（古い順、最大30）。`cwd`・`name`・`status`（idle|running|waiting|ended）・`asks`・`questions` は既存。

## 使用状況（`server/usage.mjs`）
5 時間・7 日間の利用枠と、セッションごとのコンテキスト使用量を表示するためのデータ。利用者の statusline スクリプトが、Claude Code から stdin で受けた JSON をそのまま送り、サーバーが必要な項目だけを抜き出す。

### API
`POST /api/usage` → 204。`content-type: application/json` 以外は 415、本文が 64KB を超えたら 413、不正な JSON やオブジェクトでない値は 400。

読む項目は次だけで、どれも無くてよい。型や範囲が不正な項目はその項目だけ捨て、残りは使う。

| 項目 | 有効な値 |
|---|---|
| `session_id` | 1〜256 文字 |
| `model.display_name` | 1〜100 文字 |
| `context_window.used_percentage` | 0〜100 |
| `context_window.total_input_tokens` | 0〜1e9 の整数 |
| `context_window.context_window_size` | 1〜1e9 の整数 |
| `rate_limits.{five_hour,seven_day}.used_percentage` | 0〜100 |
| `rate_limits.{five_hour,seven_day}.resets_at` | epoch 秒。正の値で、現在より先は `five_hour` が 6 時間、`seven_day` が 8 日まで |

### 保持と配信
- 利用枠はアカウント全体のものなので、サーバーで最新の 1 つだけを持つ。`used_percentage` が有効な枠を、枠ごと丸ごと置き換える。今回無い枠は前の値を残す。
- 保存済みより `resets_at` が古い枠は、放置されたセッションの古い値として無視する。どちらかに `resets_at` が無ければ比べずに置き換え、同じ `resets_at` なら最後の値を採る。
- 遠すぎる `resets_at` を受け付けないのは、一度受けると以後の値が古いと扱われ、枠が固まるため。
- 利用枠は `/api/clear` では消えず、サーバーの再起動で消える。`resets_at` を過ぎた枠もそのまま返す。
- コンテキストはサーバーが知っているセッションにだけ付ける。セッションは作らず、`updatedAt`（一覧の並びと TTL）も変えない。`context_window` に有効な項目があれば投稿の内容に丸ごと置き換え、1 つも無ければ前の値を残す。セッションと一緒に消える。
- 値が変わったときだけ配信する（statusline は頻繁に呼ばれる）。

### スナップショット（`/stream`, `/api/state`）の追加
- `usage`: `{ five_hour?: { used_percentage, resets_at? }, seven_day?: { used_percentage, resets_at? } }`。データが無ければ `null`。
- `sessions[].context`: `{ used_percentage?, tokens?, window?, model? }`（`tokens` は `total_input_tokens`、`window` は `context_window_size`）。無ければ付けない。

### 信頼と公開範囲
- 送信は `/event` と同じ扱い。トークンは不要で、Host / Origin の検証はある。サーバーに届く相手は偽の値を送れるが、変わるのは使用状況の表示だけ。
- 読めるのはトークンを持つ読み手だけ。持たない読み手には `usage: null` を返し、`sessions[].context` は含めない（`term`・`files` と同じ扱い）。

## 画面（`/workspace` = `server/public/workspace.html`）
3列。左: 一覧、中央: 端末、右: プレビュー。分担（盤面）は埋め込まず、ヘッダーの「盤面のみ」リンクで開く。端末と同じ内容の繰り返しになり、端末の高さを削るため。
- 左の一覧: スナップショットのセッション（`ended` は薄く）と、`/api/term` の端末を合わせる。`session.term === term.name` は1行にまとめる。セッション未登録の端末（起動直後・シェル）も出す。状態を色と文字で示し、回答待ち（`asks` あり）は最優先で目立たせる。1つの端末に複数セッションがある場合は更新が新しいものを使う。`/api/term` は 3 秒ごとに取り直す。
- 「新しく起動」: ディレクトリ入力（候補は既知の cwd、datalist）と mode の選択。成功したらその端末を選ぶ。直近のディレクトリは localStorage に保存（try/catch）。
- 中央: 端末があれば xterm.js + FitAddon で表示（`/vendor/xterm.js`, `/vendor/xterm.css`, `/vendor/addon-fit.js`。グローバルは `Terminal` と `FitAddon.FitAddon`）。切り替え時は古い EventSource を閉じて作り直す。リサイズは debounce して送る。「終了」ボタンは確認ダイアログつき。セッション名（`/rename` などで付けた名前）があれば、行と中央の見出しと盤面の見出しにフォルダ名・端末名の代わりに出し、端末名は小さい行に残す（`tmux attach` に使う）。名前は hook の入力 `session_title`（`SessionStart` と `UserPromptSubmit` だけ。Claude Code 2.1.332 で確認）から取るので、改名は次の指示を送ったときに反映される。会話の保存ファイルは非公開の形式なので読まない。端末がないセッションは「このセッションは画面から起動していないため、端末は表示できません」と表示し、盤面への案内を添える。
- 右: 選択セッションの `files`（新しい順）。画像は `<img>`、md/txt は `<pre>` に textContent。選択中のファイルが更新されたら読み直す。新しいファイルが来たら、利用者が手で別のファイルを選んでいない限り最新を表示。折りたたみ可。
- ヘッダーの利用枠: `usage` にある枠だけを「5時間」「7日間」の順に、バー（`role="meter"`）・使用率・リセットまでの残り時間で出す。`resets_at` を過ぎた枠はバーを灰色にして「古い値（リセット済み）」と出し、`resets_at` が無ければ残り時間を出さない。残り時間は 10 秒ごとにヘッダーだけを描き直して進める（一覧と端末には触れない）。データが無ければ（古いサーバーを含む）、statusline の設定は README を参照する旨を小さく出す。最初のスナップショットが届くまでは何も出さない。
- 一覧の行のコンテキスト使用量: `context.used_percentage` があるときだけ、バーと数値を出す。50% 以上は「注意」、80% 以上は「警告」を色と文字で示す。端末のある行で、紐づくセッションが終了しているときは出さない（画面外の終了した行は、そのセッションの値を出す）。使用率は切り捨てて整数にする。表示内容を決める関数は `server/public/rows.js`。
- トークンは `<meta name="agent-viz-token">`。無ければ「`?key=` を付けて開いてください」とだけ表示する。ページに `?key=` があれば「盤面のみ」リンクにも付ける。
- サーバー由来の文字列は textContent / DOM API のみ。`innerHTML` 禁止。外部 CDN は使わない。ダークモード対応は index.html の色変数に揃える。幅が狭いときは列を縦に積む。
