// server/public/markdown.js（プレビュー用の Markdown 変換器）の単体テスト。
// ブラウザは使わず、変換器が使ってよい DOM API だけを持つ最小の document で組み立て結果を確かめる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import '../server/public/markdown.js';

const { render } = globalThis.AgentVizMarkdown;

// innerHTML などは持たせない（使えば例外ではなく「何も出ない」になり、テストが落ちる）
class FakeText {
  constructor(text) { this.text = String(text); }
  get textContent() { return this.text; }
}
class FakeElement {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.childNodes = []; }
  set className(v) { this.attrs.class = String(v); }
  get className() { return this.attrs.class || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...kids) { for (const k of kids) this.childNodes.push(typeof k === 'string' ? new FakeText(k) : k); }
  set textContent(v) { this.childNodes = [new FakeText(v)]; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
}
const doc = { createElement: (t) => new FakeElement(t), createTextNode: (t) => new FakeText(t) };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function html(n) {
  if (n instanceof FakeText) return esc(n.text);
  const attrs = Object.keys(n.attrs).sort().map((k) => ` ${k}="${esc(n.attrs[k])}"`).join('');
  const inner = n.childNodes.map(html).join('');
  return ['br', 'hr'].includes(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}
const md = (src) => render(src, doc);
/** 変換結果の中身（外側の div.md を除く） */
const out = (src) => md(src).childNodes.map(html).join('');
const elements = (root) => {
  const all = [];
  const stack = [{ n: root, depth: 0 }];
  while (stack.length) {
    const { n, depth } = stack.pop();
    if (!(n instanceof FakeElement)) continue;
    all.push({ n, depth });
    for (const c of n.childNodes) stack.push({ n: c, depth: depth + 1 });
  }
  return all;
};
const tags = (root) => new Set(elements(root).map((e) => e.n.tag));
const link = (url, label, title = url) => `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank" title="${esc(title)}">${label}</a>`;

describe('markdown: ブロック', () => {
  it('返り値は div.md', () => {
    const root = md('a');
    assert.equal(root.tag, 'div');
    assert.equal(root.className, 'md');
  });

  it('見出し（# 〜 ######）。末尾の # は除き、空白の無い # は段落', () => {
    assert.equal(out('# 一\n## 二 ##\n###### 六'), '<h1>一</h1><h2>二</h2><h6>六</h6>');
    assert.equal(out('#タグ'), '<p>#タグ</p>');
    assert.equal(out('####### 七'), '<p>####### 七</p>');
    assert.equal(out('# C#'), '<h1>C#</h1>');
  });

  it('段落は空行で分ける。行末の空白 2 つかバックスラッシュは改行', () => {
    assert.equal(out('a\nb\n\nc'), '<p>a\nb</p><p>c</p>');
    assert.equal(out('a  \nb'), '<p>a<br>b</p>');
    assert.equal(out('a\\\nb'), '<p>a<br>b</p>');
  });

  it('CRLF も同じ', () => {
    assert.equal(out('# a\r\n\r\nb\r\n'), '<h1>a</h1><p>b</p>');
  });

  it('箇条書き（- * +）と番号付き。番号の開始値を保つ', () => {
    assert.equal(out('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(out('* a\n* b'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(out('+ a'), '<ul><li>a</li></ul>');
    assert.equal(out('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
    assert.equal(out('3) c\n4) d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  });

  it('箇条書きと番号付きが切り替わったら別の一覧', () => {
    assert.equal(out('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('入れ子の一覧（字下げ 2・3・4 のどれでも）', () => {
    assert.equal(out('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
    assert.equal(out('1. a\n   - b\n2. c'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
    assert.equal(out('1. a\n  - b'), '<ol><li>a<ul><li>b</li></ul></li></ol>');
    assert.equal(out('- a\n    1. b'), '<ul><li>a<ol><li>b</li></ol></li></ul>');
  });

  it('項目の続きの行と、空行を挟んだ段落（ゆるい一覧は <p> で包む）', () => {
    assert.equal(out('- a\n  続き'), '<ul><li>a\n続き</li></ul>');
    assert.equal(out('- a\n\n  b\n\n- c'), '<ul><li><p>a</p><p>b</p></li><li><p>c</p></li></ul>');
    assert.equal(out('- a\n\nb'), '<ul><li>a</li></ul><p>b</p>');
  });

  it('一覧の項目の中のコードブロック', () => {
    assert.equal(out('- a\n  ```\n  x  y\n  ```'), '<ul><li>a<pre><code>x  y</code></pre></li></ul>');
  });

  it('表（揃えの指定・エスケープした |・足りないセル）', () => {
    assert.equal(out('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 \\| 3 | **4** |\n| 5 |'),
      '<div class="md-table"><table><thead><tr><th class="ta-left">a</th><th class="ta-center">b</th><th class="ta-right">c</th></tr></thead>'
      + '<tbody><tr><td class="ta-left">1</td><td class="ta-center">2 | 3</td><td class="ta-right"><strong>4</strong></td></tr>'
      + '<tr><td class="ta-left">5</td></tr></tbody></table></div>');
    assert.equal(out('a | b\n--- | ---\n1 | 2'),
      '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
  });

  it('区切り行が無い・列数が合わない | は表にしない', () => {
    assert.equal(out('a | b\nc | d'), '<p>a | b\nc | d</p>');
    assert.ok(!tags(md('| a | b |\n|---|\n')).has('table'));
  });

  it('表の後は、空行や | の無い行で終わる', () => {
    assert.match(out('|a|\n|-|\n|1|\n\nafter'), /<\/table><\/div><p>after<\/p>$/);
    assert.match(out('|a|\n|-|\nafter'), /<\/table><\/div><p>after<\/p>$/);
  });

  it('フェンスのコードブロック。中の記法は変換しない。閉じ忘れは最後まで', () => {
    assert.equal(out('```js\nconst a = 1; // **x**\n\n# y\n```\nz'),
      '<pre><code class="language-js">const a = 1; // **x**\n\n# y</code></pre><p>z</p>');
    assert.equal(out('~~~\n```\n~~~'), '<pre><code>```</code></pre>');
    assert.equal(out('````\n```\n````'), '<pre><code>```</code></pre>');
    assert.equal(out('```\nabc'), '<pre><code>abc</code></pre>');
  });

  it('4 文字字下げのコードブロック', () => {
    assert.equal(out('    a\n    b\n\nc'), '<pre><code>a\nb</code></pre><p>c</p>');
  });

  it('引用（入れ子・中の一覧・続きの行）', () => {
    assert.equal(out('> a\n> b'), '<blockquote><p>a\nb</p></blockquote>');
    assert.equal(out('> a\n> > b'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>');
    assert.equal(out('> - a\n> - b'), '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
    assert.equal(out('> a\nb\n\nc'), '<blockquote><p>a\nb</p></blockquote><p>c</p>');
  });

  it('水平線', () => {
    for (const s of ['---', '***', '___', '- - -', '* * *']) assert.equal(out(s), '<hr>', s);
    assert.equal(out('a\n---\nb'), '<p>a</p><hr><p>b</p>');
  });

  it('空の入力は空', () => {
    assert.equal(out(''), '');
    assert.equal(out('\n\n  \n'), '');
  });
});

describe('markdown: 行内の記法', () => {
  it('インラインコード（中は変換しない。二重のバッククォート）', () => {
    assert.equal(out('a `**x** <b>` c'), '<p>a <code>**x** &lt;b&gt;</code> c</p>');
    assert.equal(out('`` a`b ``'), '<p><code>a`b</code></p>');
    assert.equal(out('a ` b'), '<p>a ` b</p>');
  });

  it('強調（* と _、太字、入れ子）', () => {
    assert.equal(out('*a* _b_ **c** __d__'), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>');
    assert.equal(out('***a***'), '<p><em><strong>a</strong></em></p>');
    assert.equal(out('**a *b* c**'), '<p><strong>a <em>b</em> c</strong></p>');
    assert.equal(out('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
  });

  it('日本語に隣接する強調', () => {
    assert.equal(out('これは**重要**です'), '<p>これは<strong>重要</strong>です</p>');
    assert.equal(out('**「注意」**してください'), '<p><strong>「注意」</strong>してください</p>');
    assert.equal(out('詳しくは**設定（任意）**を参照'), '<p>詳しくは<strong>設定（任意）</strong>を参照</p>');
  });

  it('強調にならないものは、そのままの文字', () => {
    assert.equal(out('snake_case_name と __init__.py'), '<p>snake_case_name と <strong>init</strong>.py</p>');
    assert.equal(out('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
    assert.equal(out('*a'), '<p>*a</p>');
    assert.equal(out('a**'), '<p>a**</p>');
    assert.equal(out('\\*a\\* \\[b\\]'), '<p>*a* [b]</p>');
  });

  it('交差した記号は壊さない', () => {
    assert.equal(out('*a _b* c_'), '<p><em>a _b</em> c_</p>');
  });

  it('http と https のリンクは、別タブ・noopener noreferrer', () => {
    assert.equal(out('[t](https://example.com/a?b=1&c=2)'), `<p>${link('https://example.com/a?b=1&c=2', 't')}</p>`);
    assert.equal(out('[t](HTTP://example.com)'), `<p>${link('HTTP://example.com', 't')}</p>`);
    assert.equal(out('<https://example.com/x>'), `<p>${link('https://example.com/x', 'https://example.com/x')}</p>`);
  });

  it('リンクの中の強調・題名・かっこを含む URL', () => {
    assert.equal(out('[**t** `c`](http://a.example)'), `<p>${link('http://a.example', '<strong>t</strong> <code>c</code>')}</p>`);
    assert.equal(out('[t](http://a.example "題")'), `<p>${link('http://a.example', 't')}</p>`);
    assert.equal(out('[w](https://ja.wikipedia.org/wiki/A_(b))。'), `<p>${link('https://ja.wikipedia.org/wiki/A_(b)', 'w')}。</p>`);
    assert.equal(out('[[1]](http://a.example)'), `<p>${link('http://a.example', '[1]')}</p>`);
  });

  it('リンクの中にリンクは作らない', () => {
    const root = md('[a [b](http://b.example) c](http://c.example)');
    const as = elements(root).filter((e) => e.n.tag === 'a');
    assert.equal(as.length, 1);
    assert.equal(as[0].n.attrs.href, 'http://b.example');
  });

  it('http/https 以外のスキームと相対リンクは、ただの文字', () => {
    const cases = [
      '[x](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x]( javascript:alert(1) )', '[x](java\tscript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox)', '[x](file:///etc/passwd)', '[x](mailto:a@example.com)',
      '[x](/api/file?path=a)', '[x](./a.md)', '[x](a.md)', '[x](#top)', '[x](//evil.example/a)', '[x](http:evil)',
      '[x](&#106;avascript:alert(1))', '[x](<javascript:alert(1)>)', '<javascript:alert(1)>', '<data:text/html,a>', '[x]()',
    ];
    for (const src of cases) {
      const root = md(src);
      assert.deepEqual([...tags(root)].sort(), ['div', 'p'], src);
      assert.equal(root.textContent, src, src);
    }
  });

  it('参照形式のリンクは変換しない（文字のまま）', () => {
    assert.equal(out('[a][b]'), '<p>[a][b]</p>');
  });

  it('画像は取得せず、代替テキストを出す', () => {
    const root = md('![図の説明](https://evil.example/track.png)');
    assert.ok(!tags(root).has('img'));
    assert.equal(html(root), '<div class="md"><p><span class="md-img">[画像: 図の説明]</span></p></div>');
    assert.equal(out('![](x.png)'), '<p><span class="md-img">[画像]</span></p>');
    assert.equal(out('[![badge](http://a.example/b.png)](https://c.example)'),
      `<p>${link('https://c.example', '<span class="md-img">[画像: badge]</span>')}</p>`);
  });
});

describe('markdown: 悪意ある入力', () => {
  it('生の HTML は文字として出す', () => {
    for (const src of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<a href="javascript:alert(1)">x</a>', '<iframe src=//evil></iframe>', '<!-- c -->']) {
      const root = md(src);
      assert.deepEqual([...tags(root)].sort(), ['div', 'p'], src);
      assert.equal(root.textContent, src, src);
    }
  });

  it('どの記法の中でも、作る要素と属性は決まったものだけ', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const src = [`# ${evil}`, `- ${evil}`, `> ${evil}`, `| ${evil} |\n|---|\n| [x](javascript:alert(1)) |`, `\`\`\`"><img src=x onerror=alert(1)>\n${evil}\n\`\`\``,
      `**${evil}**`, `[${evil}](http://a.example/"onmouseover="alert(1))`, `![" onerror="alert(1)](x)`, `\`${evil}\``, `<https://a.example/"><img>`].join('\n\n');
    const root = md(src);
    const allowedTags = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'em', 'strong', 'blockquote', 'hr', 'br', 'a', 'span']);
    const allowedAttrs = new Set(['class', 'href', 'target', 'rel', 'title', 'start']);
    for (const { n } of elements(root)) {
      assert.ok(allowedTags.has(n.tag), n.tag);
      for (const [k, v] of Object.entries(n.attrs)) {
        assert.ok(allowedAttrs.has(k), `${n.tag} ${k}`);
        if (k === 'href') assert.match(v, /^https?:\/\//i);
        if (k === 'class') assert.match(v, /^(md|md-table|md-img|md-note|ta-(left|center|right)|language-[\w+-]+)$/);
      }
    }
  });

  it('変換器のソースは、HTML 文字列を解釈する API を使わない', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'public', 'markdown.js'), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTML|\beval\(|new Function/);
  });
});

describe('markdown: 大きい・壊れた入力でも固まらない', () => {
  const deepList = Array.from({ length: 1500 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
  const wide = 10000;
  const cases = {
    '閉じない強調の連続': '*a **a _a __a '.repeat(20000),
    '記号だけ（*）': '*'.repeat(150000),
    '記号だけ（_）': '_a'.repeat(80000),
    '開きかっこの連続': '['.repeat(150000),
    'リンクもどきの連続': '[a](x'.repeat(40000),
    'リンクもどき（かっこの開き）': `${'[a](('.repeat(40000)})`,
    '閉じかっこと開きかっこ': `${'['.repeat(50000)}${']('.repeat(50000)}`,
    '題名が閉じない': '[a](http://a "'.repeat(20000),
    'バッククォートの連続': '`'.repeat(150000),
    '長さの違うバッククォート': Array.from({ length: 550 }, (_, i) => `${'`'.repeat(i + 1)}a`).join(''),
    '閉じない自動リンク': '<http://a'.repeat(30000),
    '深い引用': `${'>'.repeat(100000)} x`,
    '深い一覧': deepList,
    '行内の深い入れ子': `${'*a '.repeat(10000)}x${' b*'.repeat(10000)}`,
    '深いリンク画像': `${'!['.repeat(20000)}x${'](http://a)'.repeat(20000)}`,
    '見出しの長い空白': `#${' '.repeat(150000)}x${' '.repeat(10)}`,
    '段落の長い空白': `a${' '.repeat(150000)}b`,
    '区切り行もどき': `a|b\n${' '.repeat(100000)}x`,
    '水平線もどき': `${'- '.repeat(80000)}x`,
    '空行の多い一覧': `- a\n${'\n'.repeat(150000)}b`,
    '長い一覧': '1. a\n'.repeat(40000),
    '列の多い表': `${'a|'.repeat(wide)}\n${'-|'.repeat(wide)}\n${'|\n'.repeat(wide)}`,
    '行の多い表': `|a|\n|-|\n${'|b|\n'.repeat(50000)}`,
    '閉じないフェンス': '```\n'.repeat(1) + 'x\n'.repeat(90000),
    '改行だけ': '\n'.repeat(1_000_000),
    'NUL と制御文字': '\u0000*\u0001[\u0002](\u0003)'.repeat(10000),
  };
  for (const [name, src] of Object.entries(cases)) {
    it(`${name}`, () => {
      const t0 = process.hrtime.bigint();
      const root = md(src);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 1500, `${Math.round(ms)}ms`);
      const all = elements(root);
      assert.ok(all.length <= 25000, `要素数 ${all.length}`);
      assert.ok(Math.max(...all.slice(0, 25000).map((e) => e.depth)) <= 64, '入れ子の深さに上限');
    });
  }

  it('要素が多すぎるときは、残りを文字のまま出す（中身は失わない）', () => {
    const root = md(`${'- *a*\n'.repeat(20000)}\n末尾の目印`);
    assert.ok(elements(root).length <= 25000);
    assert.match(root.textContent, /末尾の目印/);
    assert.match(root.textContent, /整形せずに表示します/);
  });

  it('長い文書は、先頭を整形し、残りは文字のまま出す', () => {
    const root = md(`# 先頭\n\n${'本文の行です。\n\n'.repeat(1)}${'x'.repeat(250000)}\n末尾の目印`);
    assert.equal(root.childNodes[0].tag, 'h1');
    assert.match(root.textContent, /末尾の目印/);
    assert.match(root.textContent, /整形せずに表示します/);
  });

  it('非常に長い文書は、途中で打ち切って断る', () => {
    const root = md(`${'y\n'.repeat(1_000_000)}末尾の目印`);
    assert.doesNotMatch(root.textContent, /末尾の目印/);
    assert.match(root.textContent, /省略しました/);
    assert.ok(root.textContent.length < 1_100_000);
  });

  it('文字列でない入力でも落ちない', () => {
    assert.equal(out(undefined), '');
    assert.equal(out(null), '');
  });
});
