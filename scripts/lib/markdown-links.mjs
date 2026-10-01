import { fromMarkdown } from 'mdast-util-from-markdown';

const positioned = (node) => Number.isInteger(node?.position?.start?.offset)
  && Number.isInteger(node?.position?.end?.offset);

const collectNodes = (node, collected) => {
  if (positioned(node)) {
    if (node.type === 'link' || node.type === 'image') collected.links.push(node);
    if (node.type === 'html') collected.html.push(node);
  }
  for (const child of node.children ?? []) collectNodes(child, collected);
};

const inlineCodeRanges = (source, htmlNodes) => {
  const events = [];
  for (const node of htmlNodes) {
    if (/^\s*<!--/u.test(node.value)) continue;
    const tags = /<\/?code\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu;
    for (const match of node.value.matchAll(tags)) {
      events.push({
        closing: /^<\//u.test(match[0]),
        start: node.position.start.offset + match.index,
        end: node.position.start.offset + match.index + match[0].length,
      });
    }
  }
  events.sort((left, right) => left.start - right.start);
  const openings = [];
  const ranges = [];
  for (const event of events) {
    if (!event.closing) openings.push(event.start);
    else if (openings.length > 0) ranges.push({ start: openings.pop(), end: event.end });
  }
  return ranges;
};

const inside = (node, ranges) => ranges.some(({ start, end }) => (
  node.position.start.offset >= start && node.position.end.offset <= end
));

const destinationSpan = (source) => {
  const labelStart = source.startsWith('![') ? 1 : 0;
  if (source[labelStart] !== '[') return null;
  let depth = 1;
  let cursor = labelStart + 1;
  for (; cursor < source.length && depth > 0; cursor += 1) {
    if (source[cursor] === '\\') cursor += 1;
    else if (source[cursor] === '[') depth += 1;
    else if (source[cursor] === ']') depth -= 1;
  }
  if (depth !== 0 || source[cursor] !== '(') return null;
  cursor += 1;
  while (/[ \t\r\n]/u.test(source[cursor])) cursor += 1;
  if (source[cursor] === '<') {
    const start = cursor + 1;
    for (cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') cursor += 1;
      else if (source[cursor] === '>') return { start, end: cursor };
    }
    return null;
  }
  const start = cursor;
  let parentheses = 0;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') cursor += 1;
    else if (source[cursor] === '(') parentheses += 1;
    else if (source[cursor] === ')') {
      if (parentheses === 0) return { start, end: cursor };
      parentheses -= 1;
    } else if (/[ \t\r\n]/u.test(source[cursor]) && parentheses === 0) {
      return { start, end: cursor };
    }
  }
  return null;
};

const destinationReplacement = (source, node, rewrite) => {
  const nodeSource = source.slice(node.position.start.offset, node.position.end.offset);
  const span = destinationSpan(nodeSource);
  if (!span) return null;
  const url = nodeSource.slice(span.start, span.end);
  const prefix = '[target](';
  const probe = `${prefix}${url})`;
  const rewrittenProbe = rewrite(probe);
  if (!rewrittenProbe.startsWith(prefix) || !rewrittenProbe.endsWith(')')) return null;
  const rewrittenUrl = rewrittenProbe.slice(prefix.length, -1);
  if (rewrittenUrl === url) return null;
  const start = node.position.start.offset + span.start;
  return { start, end: node.position.start.offset + span.end, content: rewrittenUrl };
};

export const rewriteMarkdownOutsideCode = (source, rewrite) => {
  const collected = { links: [], html: [] };
  collectNodes(fromMarkdown(source), collected);
  const codeRanges = inlineCodeRanges(source, collected.html);
  const replacements = collected.links
    .filter((node) => !inside(node, codeRanges))
    .map((node) => destinationReplacement(source, node, rewrite))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  let rewritten = source;
  for (const replacement of replacements.reverse()) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.content}${rewritten.slice(replacement.end)}`;
  }
  return rewritten;
};
