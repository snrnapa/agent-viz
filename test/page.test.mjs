// ワークスペース画面の静的な確認（ブラウザは使わない）。
// この画面はトークンを持ち、端末でコマンドを実行できるので、HTML 文字列を解釈する API を使ってはいけない。
// また、稼働中のサーバーは画面を読み直すので、スクリプトが構文として壊れていないことも確かめる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const PUBLIC = path.join(ROOT, 'server', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'workspace.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// 画面が読み込む自作のスクリプト（同梱ライブラリ /vendor は除く）
const own = [...html.matchAll(/<script src="\/([\w-]+\.js)"><\/script>/g)].map((m) => m[1]);
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

const FORBIDDEN = [
  /\.\s*(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|srcdoc)\b/,
  /\[\s*['"`](innerHTML|outerHTML|insertAdjacentHTML|srcdoc)['"`]\s*\]/,
  /\bDOMParser\b/, /\bparseHTMLUnsafe\b/, /document\s*\.\s*write/, /\beval\s*\(/, /\bnew\s+Function\b/,
  /set(Timeout|Interval)\s*\(\s*['"`]/,
];

describe('画面: ワークスペース', () => {
  it('インラインのスクリプトは構文として正しい', () => {
    assert.ok(inline.length >= 1);
    for (const code of inline) assert.doesNotThrow(() => new vm.Script(code));
  });

  it('読み込むスクリプトは、ファイルがあり、構文として正しい', () => {
    assert.ok(own.length >= 1);
    for (const name of own) assert.doesNotThrow(() => new vm.Script(read(name)), name);
  });

  it('HTML 文字列を解釈する API を使わない', () => {
    for (const [name, code] of [['workspace.html', html], ...own.map((n) => [n, read(n)])]) {
      for (const re of FORBIDDEN) assert.equal(re.exec(code)?.[0], undefined, `${name}: ${re}`);
    }
  });

  it('外部のスクリプトやスタイルを読み込まない', () => {
    assert.equal(/<(script|link|img|iframe)\b[^>]*\b(src|href)\s*=\s*["'](https?:)?\/\//i.test(html), false);
  });

  it('新しいタブやウィンドウを開かない（URL にトークンが残るため）', () => {
    assert.equal(/window\s*\.\s*open\s*\(|target\s*[:=]\s*['"]_blank/.test(html), false);
  });
});
