import { isAlias, isMap, isPair, isSeq, parseDocument } from 'yaml';

import { codePointOrderErrors } from './deterministic-order.mjs';
import { createError } from './errors.mjs';
import { fail, ok } from './result.mjs';
import { getSchemaValidator } from './schema-registry.mjs';

const malformed = (path, message) => fail([
  createError('FACT_BLOCK_MALFORMED', path, message),
]);

const maskedLine = (line) => line.replace(/[^\n]/g, ' ');

export const maskFencedMarkdown = (source) => {
  let fence = null;
  return source.split(/(?<=\n)/).map((line) => {
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*(?:\n)?$/.exec(line);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = null;
      }
      return maskedLine(line);
    }

    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n)?$/.exec(line);
    if (!opening) return line;
    fence = { character: opening[1][0], length: opening[1].length };
    return maskedLine(line);
  }).join('');
};

const inspectNode = (node) => {
  if (!node) return null;
  if (isAlias(node)) return 'YAML aliases are not allowed.';
  if (node.tag && !node.tag.startsWith('tag:yaml.org,2002:')) return 'Custom YAML tags are not allowed.';
  if (isMap(node)) {
    for (const item of node.items) {
      if (!isPair(item)) return 'YAML mappings must contain key/value pairs.';
      if (item.key?.value === '<<') return 'YAML merge keys are not allowed.';
      const keyError = inspectNode(item.key);
      if (keyError) return keyError;
      const valueError = inspectNode(item.value);
      if (valueError) return valueError;
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      const itemError = inspectNode(item);
      if (itemError) return itemError;
    }
  }
  return null;
};

export const parseRestrictedYaml = (source, path) => {
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) return malformed(path, 'Malformed restricted YAML mapping.');
  if (!isMap(document.contents)) return malformed(path, 'Restricted YAML must be a mapping.');
  const nodeError = inspectNode(document.contents);
  if (nodeError) return malformed(path, nodeError);
  try {
    return ok(document.toJS({ maxAliasCount: 0 }));
  } catch {
    return malformed(path, 'Malformed restricted YAML mapping.');
  }
};

const schemaPath = (error) => {
  if (error.keyword === 'required') return `/frontmatter/${error.params.missingProperty}`;
  if (error.keyword === 'additionalProperties') return `/frontmatter/${error.params.additionalProperty}`;
  return `/frontmatter${error.instancePath}`;
};

export const parseFrontmatter = (source) => {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return malformed('/frontmatter', 'Exact YAML Frontmatter is required.');
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) return malformed('/frontmatter', 'Frontmatter closing delimiter is missing.');

  const parsed = parseRestrictedYaml(normalized.slice(4, closingIndex), '/frontmatter');
  if (!parsed.ok) return parsed;
  const validate = getSchemaValidator('capability-frontmatter');
  if (!validate(parsed.value)) {
    return fail(validate.errors.map((error) => createError(
      'FACT_BLOCK_MALFORMED',
      schemaPath(error),
      `Invalid capability Frontmatter: ${error.message}`,
    )));
  }

  const orderErrors = [];
  for (const field of ['implementation_refs', 'verification_refs']) {
    orderErrors.push(...codePointOrderErrors(parsed.value[field], {
      code: 'FACT_BLOCK_MALFORMED',
      pathAt: (index) => `/frontmatter/${field}/${index}`,
    }));
  }
  if (orderErrors.length > 0) return fail(orderErrors);

  return ok({
    data: parsed.value,
    body: normalized.slice(closingIndex + 5),
  });
};
