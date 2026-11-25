// プレビュー用の小さな Markdown 変換器。ワークスペース画面（classic script）と node:test の両方で使う。
// このページはトークンを持ち、端末でコマンドを実行できるので、HTML 文字列は一切解釈しない。
// 要素は createElement、文字は createTextNode / textContent だけで作る。付ける属性は class・start と、http/https のリンクのものだけ。
// 画像は取得しない。入力が大きい・壊れていても固まらないように、走査は線形にし、量と入れ子の深さに上限を置く。
(() => {
  const MAX_FORMAT = 200_000; // 整形する文字数。超えた分は文字のまま出す
  const MAX_TOTAL = 1_000_000; // 表示する文字数。超えた分は省略する
  const MAX_ELEMENTS = 20_000;
  const MAX_DEPTH = 16; // 引用・一覧の入れ子
  const MAX_INLINE_DEPTH = 16; // 強調の入れ子
  const MAX_COLUMNS = 50;
  const MAX_URL = 2048;
  const MAX_TITLE = 500;

  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const FENCE_END = /^ {0,3}(`{3,}|~{3,}) *$/;
  const HEADING = /^ {0,3}(#{1,6})(?: |$)/;
  const QUOTE = /^ {0,3}>/;
  const LIST = /^( *)([-+*]|\d{1,9}[.)])( +|$)/;

  // ===== ブロック =====
  const isBlank = (line) => line.trim() === '';
  const indentOf = (line) => line.length - line.trimStart().length;
  const expandIndent = (line) => line.replace(/^[ \t]+/, (m) => m.replaceAll('\t', '    '));

  function isRule(line) {
    const t = line.trim();
    const c = t[0];
    if (t.length < 3 || (c !== '-' && c !== '*' && c !== '_') || indentOf(line) > 3) return false;
    let count = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === c) count++;
      else if (t[i] !== ' ') return false;
    }
    return count >= 3;
  }

  function fenceOpen(line) {
    const m = FENCE.exec(line);
    return m && !(m[1][0] === '`' && m[2].includes('`')) ? m : null;
  }

  function listItem(line) {
    const m = LIST.exec(line);
    if (!m) return null;
    const [, space, marker, gap] = m;
    const markerEnd = space.length + marker.length;
    // 記号の後の空白が多すぎるときは、1 つだけを区切りにする（残りは本文の字下げ）
    const contentIndent = markerEnd + (gap.length >= 1 && gap.length <= 4 ? gap.length : 1);
    const ordered = marker.length > 1 || (marker >= '0' && marker <= '9');
    return { indent: space.length, ordered, start: ordered ? parseInt(marker, 10) : 1, contentIndent, content: line.slice(contentIndent) };
  }

  function splitRow(line) {
    const t = line.trim();
    const cells = [];
    let cell = '';
    let endsWithPipe = false;
    for (let i = 0; i < t.length; i++) {
      endsWithPipe = false;
      if (t[i] === '\\' && t[i + 1] === '|') { cell += '|'; i++; continue; }
      if (t[i] === '|') { cells.push(cell.trim()); cell = ''; endsWithPipe = true; continue; }
      cell += t[i];
    }
    if (!endsWithPipe) cells.push(cell.trim());
    if (t.startsWith('|')) cells.shift();
    return cells;
  }

  function tableAt(lines, i) {
    const sep = lines[i + 1];
    if (sep === undefined || !lines[i].includes('|') || !sep.includes('-') || !/^[ |:-]+$/.test(sep)) return null;
    const marks = splitRow(sep);
    if (!marks.length || marks.length > MAX_COLUMNS || !marks.every((c) => /^:?-+:?$/.test(c))) return null;
    const head = splitRow(lines[i]);
    if (head.length !== marks.length) return null;
    const aligns = marks.map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'ta-center' : 'ta-right') : c.startsWith(':') ? 'ta-left' : ''));
    return { head, aligns };
  }

  // 段落や一覧の続きを打ち切る行か
  function startsBlock(lines, i, depth) {
    const line = lines[i];
    if (fenceOpen(line) || HEADING.test(line) || isRule(line)) return true;
    if (depth < MAX_DEPTH) {
      if (QUOTE.test(line)) return true;
      const item = listItem(line);
      // 番号付きは 1 始まりのときだけ段落を打ち切る（本文中の「2023. 」などを一覧にしない）
      if (item && item.indent < 4 && item.content.trim() && (!item.ordered || item.start === 1)) return true;
    }
    return !!tableAt(lines, i);
  }

  // ===== 要素の組み立て =====
  function el(ctx, tag, parent, className) {
    ctx.left--;
    const node = ctx.doc.createElement(tag);
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function note(ctx, parent, text) { el(ctx, 'p', parent, 'md-note').textContent = text; }
  function plain(ctx, parent, text) {
    note(ctx, parent, '（大きいため、ここから先は整形せずに表示します）');
    el(ctx, 'pre', parent).textContent = text;
  }
  function codeBlock(ctx, parent, text, lang) {
    const code = el(ctx, 'code', el(ctx, 'pre', parent), lang ? `language-${lang}` : '');
    code.textContent = text;
  }

  // tight は、詰まった一覧の項目（段落を <p> で包まない）
  function blocks(ctx, parent, lines, depth, tight = false) {
    let i = 0;
    while (i < lines.length) {
      if (ctx.left <= 0) { plain(ctx, parent, lines.slice(i).join('\n')); return; }
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      const fence = fenceOpen(line);
      if (fence) { i = fenced(ctx, parent, lines, i, fence); continue; }
      if (indentOf(line) >= 4) { i = indented(ctx, parent, lines, i); continue; }
      const heading = HEADING.exec(line);
      if (heading) {
        inline(ctx, el(ctx, `h${heading[1].length}`, parent), headingText(line.slice(heading[0].length)));
        i++;
        continue;
      }
      if (isRule(line)) { el(ctx, 'hr', parent); i++; continue; }
      if (depth < MAX_DEPTH && QUOTE.test(line)) { i = quote(ctx, parent, lines, i, depth); continue; }
      if (depth < MAX_DEPTH && listItem(line)) { i = list(ctx, parent, lines, i, depth); continue; }
      const table = tableAt(lines, i);
      if (table) { i = tableBlock(ctx, parent, lines, i, table, depth); continue; }
      const buf = [line.trimStart()];
      for (i++; i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i, depth); i++) buf.push(lines[i].trimStart());
      inline(ctx, tight ? parent : el(ctx, 'p', parent), buf.join('\n').trimEnd());
    }
  }

  // 見出しの末尾の「 ###」は飾りなので除く（「C#」の # は残す）
  function headingText(raw) {
    const text = raw.trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end--;
    if (end === 0) return '';
    return end < text.length && text[end - 1] === ' ' ? text.slice(0, end).trimEnd() : text;
  }

  function fenced(ctx, parent, lines, i, open) {
    const mark = open[1];
    const indent = indentOf(lines[i]);
    const body = [];
    for (i++; i < lines.length; i++) {
      const end = FENCE_END.exec(lines[i]);
      if (end && end[1][0] === mark[0] && end[1].length >= mark.length) { i++; break; }
      body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
    }
    const lang = open[2].trim().split(/\s/)[0];
    codeBlock(ctx, parent, body.join('\n'), /^[\w+-]{1,32}$/.test(lang) ? lang : '');
    return i;
  }

  function indented(ctx, parent, lines, i) {
    const body = [];
    for (; i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4); i++) body.push(lines[i].slice(4));
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    codeBlock(ctx, parent, body.join('\n'), '');
    return i;
  }

  function quote(ctx, parent, lines, i, depth) {
    const body = [];
    let lazy = false; // 直前が引用内の本文なら、「>」の無い行も続きにする
    for (; i < lines.length; i++) {
      if (QUOTE.test(lines[i])) {
        const s = expandIndent(lines[i].replace(/^ {0,3}> ?/, ''));
        body.push(s);
        lazy = !isBlank(s) && !fenceOpen(s) && !HEADING.test(s) && !isRule(s);
      } else if (lazy && !isBlank(lines[i]) && !startsBlock(lines, i, depth)) body.push(lines[i]);
      else break;
    }
    blocks(ctx, el(ctx, 'blockquote', parent), body, depth + 1);
    return i;
  }

  function list(ctx, parent, lines, i, depth) {
    const first = listItem(lines[i]);
    const items = [];
    let loose = false;
    while (i < lines.length) {
      const item = listItem(lines[i]);
      if (!item || item.ordered !== first.ordered || isRule(lines[i])) break;
      const entry = { start: i, body: [item.content] };
      items.push(entry);
      let blanks = 0;
      for (i++; i < lines.length; i++) {
        const line = lines[i];
        if (isBlank(line)) { blanks++; continue; }
        const indent = indentOf(line);
        if (indent >= item.contentIndent || (indent >= item.indent + 2 && LIST.test(line))) {
          const s = line.slice(Math.min(indent, item.contentIndent));
          if (blanks && !s.startsWith(' ') && !LIST.test(s)) loose = true;
          for (; blanks; blanks--) entry.body.push('');
          entry.body.push(s);
        } else if (!blanks && !startsBlock(lines, i, depth) && !listItem(line)) entry.body.push(line.trimStart());
        else break;
      }
      if (blanks && i < lines.length && listItem(lines[i])?.ordered === first.ordered) loose = true;
    }
    const box = el(ctx, first.ordered ? 'ol' : 'ul', parent);
    if (first.ordered && first.start !== 1) box.setAttribute('start', String(first.start));
    for (const entry of items) {
      if (ctx.left <= 0) return entry.start; // 残りは呼び出し元が文字のまま出す
      blocks(ctx, el(ctx, 'li', box), entry.body, depth + 1, !loose);
    }
    return i;
  }

  function tableBlock(ctx, parent, lines, i, { head, aligns }, depth) {
    const table = el(ctx, 'table', el(ctx, 'div', parent, 'md-table'));
    const row = (box, tag, cells) => {
      const tr = el(ctx, 'tr', box);
      // 足りないセルは補わない（列の多い表で要素が膨らまないように）
      cells.slice(0, head.length).forEach((text, n) => inline(ctx, el(ctx, tag, tr, aligns[n]), text));
    };
    row(el(ctx, 'thead', table), 'th', head);
    const body = el(ctx, 'tbody', table);
    for (i += 2; i < lines.length && ctx.left > 0; i++) {
      if (isBlank(lines[i]) || !lines[i].includes('|') || startsBlock(lines, i, depth)) break;
      row(body, 'td', splitRow(lines[i]));
    }
    return i;
  }

  // ===== 行内 =====
  const SPECIAL = /[\\`*_[\]!<\n]/g;
  const AUTOLINK = /<(https?:\/\/[^\s<>]{0,2048})>/iy;
  const ESCAPABLE = /^[!-/:-@[-`{-~]$/;
  const isSpace = (c) => /\s/.test(c);
  const isPunct = (c) => /[\p{P}\p{S}]/u.test(c);
  const isWord = (c) => /[\p{L}\p{N}]/u.test(c);
  const isCjk = (c) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(c);

  function allowedUrl(url) {
    if (!/^https?:\/\//i.test(url)) return false;
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch { return false; }
  }

  // `*` と `_` の並びが、強調の開き・閉じになれるか。日本語は分かち書きしないので、隣が仮名・漢字なら約物の内側でも認める
  function delimiter(s, i, len) {
    const ch = s[i];
    const before = s[i - 1] || ' ';
    const after = s[i + len] || ' ';
    const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before) || isCjk(before));
    const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after) || isCjk(after));
    const open = ch === '*' ? left : left && !isWord(before);
    const close = ch === '*' ? right : right && !isWord(after);
    return { t: 'delim', ch, len, size: len, open, close, opens: [], closes: 0 };
  }

  // 開きと閉じを対応づける。記号の種類ごとの積み重ねにして、全体を 1 回の走査で終える
  function resolve(tokens, from) {
    const stacks = { '*': [], _: [] };
    for (let k = from; k < tokens.length; k++) {
      const d = tokens[k];
      if (d.t !== 'delim') continue;
      const stack = stacks[d.ch];
      const other = stacks[d.ch === '*' ? '_' : '*'];
      while (d.close && d.len > 0 && stack.length) {
        const at = stack[stack.length - 1];
        const o = tokens[at];
        // CommonMark の「3 の倍数」の規則（*a**b**c* を正しく解く）
        if ((o.close || d.open) && (o.size + d.size) % 3 === 0 && !(o.size % 3 === 0 && d.size % 3 === 0)) break;
        const use = o.len >= 2 && d.len >= 2 ? 2 : 1;
        o.opens.push(use === 2 ? 'strong' : 'em'); // 後に対応したものほど外側
        d.closes++;
        o.len -= use;
        d.len -= use;
        // 間にある別の記号は、この強調をまたげないので文字にする
        while (other.length && other[other.length - 1] > at) other.pop();
        if (o.len === 0) stack.pop();
      }
      if (d.open && d.len > 0) stack.push(k);
    }
  }

  // "](" の "(" の位置から、リンク先と任意の題名を読む。読めなければ null
  function destination(s, p) {
    let j = p + 1;
    const skip = () => { while (s[j] === ' ' || s[j] === '\n') j++; };
    skip();
    let url;
    if (s[j] === '<') {
      const start = ++j;
      while (j < s.length && s[j] !== '>' && s[j] !== '\n' && j - start <= MAX_URL) j++;
      if (s[j] !== '>') return null;
      url = s.slice(start, j++);
    } else {
      const start = j;
      let depth = 0;
      for (; j < s.length && s[j] > ' ' && j - start <= MAX_URL; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') {
          if (depth === 0) break;
          depth--;
        }
      }
      if (depth || j - start > MAX_URL) return null;
      url = s.slice(start, j);
    }
    skip();
    const quoteChar = s[j];
    if (quoteChar === '"' || quoteChar === "'") {
      const start = ++j;
      while (j < s.length && s[j] !== quoteChar && j - start <= MAX_TITLE) j++;
      if (s[j] !== quoteChar) return null;
      j++;
      skip();
    }
    return s[j] === ')' ? { url, end: j + 1 } : null;
  }

  function tokenize(s) {
    const tokens = [];
    const brackets = []; // 閉じを待っている "[" と "!["
    let linkFloor = 0; // これより前の "[" はリンクにしない（リンクの中にリンクを作らない）
    let nextClose = -1; // 次の ")" の位置（無ければリンク先を読みに行かない）
    // バッククォートの並びを長さごとに控えて、閉じを探し直さない
    const ticks = new Map();
    for (const m of s.matchAll(/`+/g)) {
      if (!ticks.has(m[0].length)) ticks.set(m[0].length, { at: [], next: 0 });
      ticks.get(m[0].length).at.push(m.index);
    }
    const text = (v) => tokens.push({ t: 'text', v });
    const run = (i) => { let j = i + 1; while (s[j] === s[i]) j++; return j - i; };

    let i = 0;
    while (i < s.length) {
      SPECIAL.lastIndex = i;
      const found = SPECIAL.exec(s);
      const j = found ? found.index : s.length;
      if (j > i) text(s.slice(i, j));
      if (!found) break;
      i = j;
      const c = s[i];
      if (c === '\\') {
        if (s[i + 1] === '\n') { tokens.push({ t: 'br' }); i += 2; }
        else if (ESCAPABLE.test(s[i + 1] || '')) { text(s[i + 1]); i += 2; }
        else { text(c); i++; }
      } else if (c === '\n') {
        if (s[i - 1] === ' ' && s[i - 2] === ' ') {
          const last = tokens[tokens.length - 1];
          if (last?.t === 'text') last.v = last.v.trimEnd();
          tokens.push({ t: 'br' });
        } else text(c);
        i++;
      } else if (c === '`') {
        const len = run(i);
        const same = ticks.get(len);
        while (same && same.next < same.at.length && same.at[same.next] < i + len) same.next++;
        if (same && same.next < same.at.length) {
          const end = same.at[same.next];
          let v = s.slice(i + len, end).replaceAll('\n', ' ');
          if (v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
          tokens.push({ t: 'code', v });
          i = end + len;
        } else { text(s.slice(i, i + len)); i += len; }
      } else if (c === '*' || c === '_') {
        const len = run(i);
        tokens.push(delimiter(s, i, len));
        i += len;
      } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
        const len = c === '!' ? 2 : 1;
        brackets.push({ at: tokens.length, image: c === '!', label: i + len });
        text(s.slice(i, i + len));
        i += len;
      } else if (c === ']') {
        const b = brackets.pop();
        let dest = null;
        if (b && (b.image || b.at >= linkFloor) && s[i + 1] === '(') {
          if (nextClose <= i) {
            const n = s.indexOf(')', i + 1);
            nextClose = n < 0 ? Infinity : n;
          }
          if (nextClose !== Infinity) dest = destination(s, i + 1);
        }
        if (!dest) { text(c); i++; continue; }
        if (b.image) {
          const alt = s.slice(b.label, Math.min(i, b.label + MAX_TITLE));
          tokens.length = b.at;
          tokens.push({ t: 'img', alt });
        } else if (allowedUrl(dest.url)) {
          resolve(tokens, b.at + 1);
          const kids = tokens.splice(b.at).slice(1);
          tokens.push({ t: 'link', url: dest.url, kids });
          linkFloor = b.at;
        } else text(s.slice(i, dest.end)); // 使えないリンク先は、書かれたとおりの文字にする
        i = dest.end;
      } else if (c === '<') {
        AUTOLINK.lastIndex = i;
        const m = AUTOLINK.exec(s);
        if (m && allowedUrl(m[1])) { tokens.push({ t: 'link', url: m[1], kids: [{ t: 'text', v: m[1] }] }); i += m[0].length; }
        else { text(c); i++; }
      } else { text(c); i++; }
    }
    resolve(tokens, 0);
    return tokens;
  }

  // 要素の上限に達したら、装飾をやめて文字だけを出す
  function emit(ctx, parent, tokens, inLink) {
    const stack = [parent];
    let buf = '';
    const top = () => stack[stack.length - 1];
    const flush = () => { if (buf) top().append(ctx.doc.createTextNode(buf)); buf = ''; };
    for (const tk of tokens) {
      if (tk.t === 'text') buf += tk.v;
      else if (tk.t === 'delim') {
        if (tk.closes) flush();
        for (let n = 0; n < tk.closes && stack.length > 1; n++) stack.pop();
        buf += tk.ch.repeat(tk.len);
        if (tk.opens.length) flush();
        for (let n = tk.opens.length - 1; n >= 0; n--) {
          stack.push(stack.length > MAX_INLINE_DEPTH || ctx.left <= 0 ? top() : el(ctx, tk.opens[n], top()));
        }
      } else if (tk.t === 'link') {
        flush();
        if (inLink || ctx.left <= 0) emit(ctx, top(), tk.kids, true);
        else {
          const a = el(ctx, 'a', top());
          a.setAttribute('href', tk.url);
          a.setAttribute('title', tk.url); // 表示と違う行き先を確かめられるように
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          emit(ctx, a, tk.kids, true);
        }
      } else if (tk.t === 'img') {
        const label = tk.alt ? `[画像: ${tk.alt}]` : '[画像]';
        if (ctx.left <= 0) buf += label;
        else { flush(); el(ctx, 'span', top(), 'md-img').textContent = label; }
      } else if (tk.t === 'code') {
        if (ctx.left <= 0) buf += tk.v;
        else { flush(); el(ctx, 'code', top()).textContent = tk.v; }
      } else if (tk.t === 'br') {
        if (ctx.left <= 0) buf += '\n';
        else { flush(); el(ctx, 'br', top()); }
      }
    }
    flush();
  }

  function inline(ctx, parent, source) {
    if (ctx.left <= 0) { parent.append(ctx.doc.createTextNode(source)); return; }
    emit(ctx, parent, tokenize(source), false);
  }

  /** Markdown を、<div class="md"> の要素に組み立てて返す。 */
  function render(source, doc = globalThis.document) {
    const ctx = { doc, left: MAX_ELEMENTS };
    const root = doc.createElement('div');
    root.className = 'md';
    let text = typeof source === 'string' ? source : '';
    const omitted = text.length > MAX_TOTAL;
    if (omitted) text = text.slice(0, MAX_TOTAL);
    text = text.replace(/\r\n?/g, '\n');
    let rest = '';
    if (text.length > MAX_FORMAT) {
      const nl = text.lastIndexOf('\n', MAX_FORMAT);
      const cut = nl > 0 ? nl : MAX_FORMAT;
      rest = text.slice(cut);
      text = text.slice(0, cut);
    }
    blocks(ctx, root, text.split('\n').map(expandIndent), 0);
    if (rest) plain(ctx, root, rest);
    if (omitted) note(ctx, root, '（長いため、以降は省略しました）');
    return root;
  }

  globalThis.AgentVizMarkdown = { render };
})();
