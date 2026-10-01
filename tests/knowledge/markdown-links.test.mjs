import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteMarkdownOutsideCode } from '../../scripts/lib/markdown-links.mjs';

const rewrite = (source) => rewriteMarkdownOutsideCode(
  source,
  (text) => text.replaceAll('./old.md', './new.md'),
);

test('preserves raw HTML code blocks while rewriting later navigation', () => {
  for (const tag of ['script', 'style', 'textarea']) {
    const source = `<${tag}>\n[example](./old.md)\n</${tag}>\n\n[real](./old.md)\n`;
    assert.equal(rewrite(source), `<${tag}>\n[example](./old.md)\n</${tag}>\n\n[real](./new.md)\n`);
  }
});

test('recognizes a tab-indented closing fence inside a list', () => {
  const source = '- ```md\n  [example](./old.md)\n\t```\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), '- ```md\n  [example](./old.md)\n\t```\n\n[real](./new.md)\n');
});

test('does not join unmatched backticks across Markdown blocks', () => {
  const source = '`one\n\n[real](./old.md)\n\n`two\n';
  assert.equal(rewrite(source), '`one\n\n[real](./new.md)\n\n`two\n');
});

test('preserves fences nested below multiple list containers', () => {
  const source = '- a\n  - b\n    - ~~~md\n      [example](./old.md)\n      ~~~\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), '- a\n  - b\n    - ~~~md\n      [example](./old.md)\n      ~~~\n\n[real](./new.md)\n');
});

test('recognizes indented code when entering a blockquote container', () => {
  const source = 'Paragraph\n>     [example](./old.md)\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), 'Paragraph\n>     [example](./old.md)\n\n[real](./new.md)\n');
});

test('rewrites links after an escaped HTML comment opener', () => {
  const source = '\\<!-- [real](./old.md) -->\n';
  assert.equal(rewrite(source), '\\<!-- [real](./new.md) -->\n');
});

test('distinguishes heading-interrupting code from a lazy blockquote continuation', () => {
  const source = '# Heading\n    [example](./old.md)\n\n> quote\n    [real](./old.md)\n';
  assert.equal(rewrite(source), '# Heading\n    [example](./old.md)\n\n> quote\n    [real](./new.md)\n');
});

test('stops unmatched code spans at nonblank block boundaries', () => {
  for (const boundary of ['# Heading', '- item', '> quote', '---']) {
    const source = `\`one\n${boundary}\n[real](./old.md)\n\`two\n`;
    assert.equal(rewrite(source), `\`one\n${boundary}\n[real](./new.md)\n\`two\n`);
  }
});

test('preserves the complete closing line of raw HTML blocks', () => {
  const source = '<pre>\n[example](./old.md)\n</pre> [same line](./old.md)\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), '<pre>\n[example](./old.md)\n</pre> [same line](./old.md)\n\n[real](./new.md)\n');
});

test('preserves indented code introduced by list-marker padding', () => {
  const source = '-     [example](./old.md)\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), '-     [example](./old.md)\n\n[real](./new.md)\n');
});

test('stops unmatched code spans at setext headings', () => {
  const source = '`one\n===\n[real](./old.md)\n`two\n';
  assert.equal(rewrite(source), '`one\n===\n[real](./new.md)\n`two\n');
});

test('preserves raw HTML code blocks inside Markdown containers', () => {
  for (const source of [
    '> <pre>\n> [example](./old.md)\n> </pre>\n\n[real](./old.md)\n',
    '- <pre>\n  [example](./old.md)\n  </pre>\n\n[real](./old.md)\n',
  ]) {
    assert.equal(rewrite(source).match(/\.\/old\.md/gu)?.length, 1);
    assert.match(rewrite(source), /\[real\]\(\.\/new\.md\)/u);
  }
});

test('keeps code spans open across ordered markers that cannot interrupt paragraphs', () => {
  const source = '`sample\n2. [example](./old.md)\nclosing`\n\n[real](./old.md)\n';
  assert.equal(rewrite(source), '`sample\n2. [example](./old.md)\nclosing`\n\n[real](./new.md)\n');
});

test('rewrites standalone and nested image destinations independently', () => {
  const source = '![standalone](./old.md)\n\n[![nested](./old.md)](./old.md)\n';
  assert.equal(rewrite(source), '![standalone](./new.md)\n\n[![nested](./new.md)](./new.md)\n');
});

test('rewrites a destination without changing a repeated title', () => {
  const source = '[target](./old.md "./old.md")\n';
  assert.equal(rewrite(source), '[target](./new.md "./old.md")\n');
});
