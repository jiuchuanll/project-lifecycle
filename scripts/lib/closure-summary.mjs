import { createHash } from 'node:crypto';

const CLOSURE_SUMMARY_MARKER = /^<!-- project-lifecycle:closure-summary sha256=([0-9a-f]{64}) -->\n?/u;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

export const closureSummaryHash = (summary) => createHash('sha256')
  .update(JSON.stringify(canonicalize(summary)))
  .digest('hex');

export const closureSummaryMarker = (digest) => `<!-- project-lifecycle:closure-summary sha256=${digest} -->`;

export const withoutManagedClosureSummaryHash = (body) => {
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  if (CLOSURE_SUMMARY_MARKER.test(normalized)) return normalized.replace(CLOSURE_SUMMARY_MARKER, '');
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(normalized);
  if (!title) return normalized;
  const rest = normalized.slice(title[0].length);
  return CLOSURE_SUMMARY_MARKER.test(rest)
    ? `${title[0]}${rest.replace(CLOSURE_SUMMARY_MARKER, '')}`
    : normalized;
};

export const addClosureSummaryHash = (body, digest) => {
  const withoutMarker = withoutManagedClosureSummaryHash(body);
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(withoutMarker);
  if (!title) return `${closureSummaryMarker(digest)}\n${withoutMarker}`;
  return `${title[0]}${closureSummaryMarker(digest)}\n${withoutMarker.slice(title[0].length)}`;
};

export const extractClosureSummaryHash = (body) => {
  const normalized = body.replaceAll('\r\n', '\n').replace(/^\n/u, '');
  const direct = CLOSURE_SUMMARY_MARKER.exec(normalized);
  if (direct) return direct[1];
  const title = /^(#[ \t]+[^\n]+\n(?:\n)?)/u.exec(normalized);
  return title ? CLOSURE_SUMMARY_MARKER.exec(normalized.slice(title[0].length))?.[1] ?? null : null;
};
