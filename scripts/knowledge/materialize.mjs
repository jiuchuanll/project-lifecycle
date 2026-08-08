import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';

const englishTemplateUrl = new URL(
  '../../skills/maintain-project-knowledge/assets/capability-en.md',
  import.meta.url,
);
const chineseTemplateUrl = new URL(
  '../../skills/maintain-project-knowledge/assets/capability.md',
  import.meta.url,
);

const pairLanguages = ['en', 'zh-CN'];
const documentFields = [
  'title',
  'purpose_and_current_boundary',
  'facts',
  'system_and_data_relationships',
  'implementation_and_resource_map',
  'quality_state',
  'dependencies',
  'unknowns',
  'provenance',
];

const materializationFailure = (code, path, message) => fail([
  createError(code, path, message),
]);

const stableWriteCodes = new Set([
  'PATH_ESCAPE',
  'PATH_SYMLINK_ESCAPE',
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const jsonContent = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const orderedUniqueStrings = (value, { allowEmpty = false } = {}) => Array.isArray(value)
  && (allowEmpty || value.length > 0)
  && value.every(isNonEmptyString)
  && new Set(value).size === value.length
  && value.every((entry, index) => index === 0 || compareCodePoints(value[index - 1], entry) <= 0);

const exactKeys = (value, expected) => isRecord(value)
  && Object.keys(value).length === expected.length
  && expected.every((field) => Object.hasOwn(value, field));

const fileState = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const replaceOnce = (source, needle, replacement) => {
  const index = source.indexOf(needle);
  if (index === -1) {
    const error = new Error('Capability template is incomplete.');
    error.code = 'MATERIALIZATION_TEMPLATE_INVALID';
    throw error;
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
};

const yamlInline = (value) => JSON.stringify(value);

const factContent = (facts, language) => facts.map((fact) => [
  `### \`${fact.fact_id}\``,
  '',
  '<!-- project-lifecycle:fact',
  `fact_id: ${fact.fact_id}`,
  `revision: ${fact.revision}`,
  `evidence_refs: ${yamlInline(fact.evidence_refs)}`,
  `last_verified_baseline: ${yamlInline(fact.last_verified_baseline)}`,
  '-->',
  '',
  fact.statement,
  '',
  language === 'en' ? '#### Known limits' : '#### 已知限制',
  '',
  fact.known_limits,
  '',
  '<!-- /project-lifecycle:fact -->',
].join('\n')).join('\n\n');

const bulletContent = (items) => items.map((item) => `- ${item}`).join('\n');

const renderDocument = ({
  template,
  domainId,
  knowledgeState,
  pairedAsset,
  baseline,
  implementationRefs,
  verificationRefs,
  document,
  language,
  ownerId,
  dependencyIds,
  approvalRef,
}) => {
  let source = template;
  source = replaceOnce(source, 'id: template-capability', `id: ${domainId}`);
  source = replaceOnce(source, 'knowledge_state: proposed', `knowledge_state: ${knowledgeState}`);
  source = replaceOnce(source, 'paired_asset: capability.md', `paired_asset: ${yamlInline(pairedAsset)}`);
  source = replaceOnce(source, 'last_verified_baseline: replace-with-baseline', `last_verified_baseline: ${yamlInline(baseline)}`);
  source = replaceOnce(source, 'implementation_refs: []', `implementation_refs: ${yamlInline(implementationRefs)}`);
  source = replaceOnce(source, 'verification_refs: []', `verification_refs: ${yamlInline(verificationRefs)}`);

  const dependencyLines = dependencyIds.length === 0
    ? (language === 'en' ? 'Declared dependencies: none.' : '已声明依赖：无。')
    : dependencyIds.map((dependencyId) => (
      language === 'en'
        ? `Declared dependency: \`${dependencyId}\``
        : `已声明依赖：\`${dependencyId}\``
    )).join('\n');
  const ownerLine = language === 'en'
    ? `Canonical owner: \`${ownerId}\``
    : `规范所有者：\`${ownerId}\``;
  const approvalLine = knowledgeState === 'current'
    ? (language === 'en'
      ? `Approval: \`${approvalRef}\``
      : `批准依据：\`${approvalRef}\``)
    : (language === 'en'
      ? 'Approval: not required while knowledge remains proposed.'
      : '批准依据：知识保持 proposed 状态时不要求批准。');
  const replacements = language === 'en'
    ? [
      ['Capability title', document.title],
      ['Describe the capability purpose and its accepted boundary.', document.purpose_and_current_boundary],
      ['Add only durable facts with structured fact metadata and explicit limits.', factContent(document.facts, language)],
      ['Describe the system and data relationships that affect this capability.', `${ownerLine}\n\n${document.system_and_data_relationships}`],
      ['List the smallest stable implementation and resource entry points.', document.implementation_and_resource_map],
      ['Describe the verified quality state and evidence coverage.', document.quality_state],
      ['Describe the declared major dependencies used for routing.', `${dependencyLines}\n\n${document.dependencies}`],
      ['State explicit limits, unknowns, confidence bounds, and unresolved risks.', bulletContent(document.unknowns)],
      ['Summarize the authoritative evidence and human decisions behind the asset.', `${approvalLine}\n\n${document.provenance}`],
    ]
    : [
      ['能力标题', document.title],
      ['说明该能力的用途及其已确认边界。', document.purpose_and_current_boundary],
      ['只记录带结构化事实元数据和明确限制的耐久事实。', factContent(document.facts, language)],
      ['说明影响该能力的系统关系与数据关系。', `${ownerLine}\n\n${document.system_and_data_relationships}`],
      ['列出最小且稳定的实现与资源入口。', document.implementation_and_resource_map],
      ['说明已验证的质量状态与证据覆盖情况。', document.quality_state],
      ['说明用于路由的已声明主要依赖。', `${dependencyLines}\n\n${document.dependencies}`],
      ['明确记录限制、未知项、置信边界和未解决风险。', bulletContent(document.unknowns)],
      ['概述支撑该资产的权威证据与人工决策。', `${approvalLine}\n\n${document.provenance}`],
    ];
  for (const [needle, replacement] of replacements) source = replaceOnce(source, needle, replacement);
  return source;
};

const validateDocumentInput = (document, language) => {
  if (!exactKeys(document, documentFields)) {
    return materializationFailure(
      'MATERIALIZATION_PAIR_REQUIRED',
      `/pair/${language}`,
      'Both localized capability candidates must be complete.',
    );
  }
  for (const field of documentFields.filter((field) => !['facts', 'unknowns'].includes(field))) {
    if (!isNonEmptyString(document[field])) {
      return materializationFailure(
        'MATERIALIZATION_INPUT_INVALID',
        `/pair/${language}/${field}`,
        'Localized capability content must be explicit.',
      );
    }
  }
  if (!Array.isArray(document.facts) || document.facts.length === 0) {
    return materializationFailure(
      'MATERIALIZATION_FACT_REQUIRED',
      `/pair/${language}/facts`,
      'At least one durable fact is required.',
    );
  }
  if (!Array.isArray(document.unknowns) || document.unknowns.length === 0
    || document.unknowns.some((entry) => !isNonEmptyString(entry))) {
    return materializationFailure(
      'MATERIALIZATION_INPUT_INVALID',
      `/pair/${language}/unknowns`,
      'Explicit unknowns or a localized no-known-unknowns statement is required.',
    );
  }
  return ok(document);
};

const validateFact = (fact, language, index, authoritativeEvidenceRefs, baseline) => {
  const path = `/pair/${language}/facts/${index}`;
  if (!exactKeys(fact, ['fact_id', 'revision', 'evidence_refs', 'statement', 'known_limits'])) {
    return materializationFailure(
      'FACT_BLOCK_MALFORMED',
      path,
      'Durable fact content is incomplete.',
    );
  }
  if (!isId(fact.fact_id) || !Number.isInteger(fact.revision) || fact.revision < 1
    || !isNonEmptyString(fact.statement) || !isNonEmptyString(fact.known_limits)) {
    return materializationFailure(
      'FACT_BLOCK_MALFORMED',
      path,
      'Durable fact metadata or localized content is invalid.',
    );
  }
  if (!orderedUniqueStrings(fact.evidence_refs)
    || fact.evidence_refs.some((reference) => !authoritativeEvidenceRefs.includes(reference))) {
    return materializationFailure(
      'MATERIALIZATION_EVIDENCE_REQUIRED',
      `${path}/evidence_refs`,
      'Every durable fact requires declared authoritative evidence.',
    );
  }
  return ok({ ...fact, last_verified_baseline: baseline });
};

const validatePairInput = (pair, authoritativeEvidenceRefs, baseline) => {
  if (!exactKeys(pair, pairLanguages)) {
    return materializationFailure(
      'MATERIALIZATION_PAIR_REQUIRED',
      '/pair',
      'Exactly one English and one Chinese capability candidate are required.',
    );
  }
  const normalized = {};
  for (const language of pairLanguages) {
    const documentResult = validateDocumentInput(pair[language], language);
    if (!documentResult.ok) return documentResult;
    const facts = [];
    for (const [index, fact] of pair[language].facts.entries()) {
      const factResult = validateFact(fact, language, index, authoritativeEvidenceRefs, baseline);
      if (!factResult.ok) return factResult;
      facts.push(factResult.value);
    }
    normalized[language] = { ...clone(pair[language]), facts };
  }

  if (normalized.en.facts.length !== normalized['zh-CN'].facts.length) {
    return materializationFailure(
      'PAIR_SECTION_MISMATCH',
      '/pair/facts',
      'Bilingual fact counts must match.',
    );
  }
  for (const [index, englishFact] of normalized.en.facts.entries()) {
    const chineseFact = normalized['zh-CN'].facts[index];
    for (const field of ['fact_id', 'revision', 'evidence_refs', 'last_verified_baseline']) {
      if (!same(englishFact[field], chineseFact[field])) {
        return materializationFailure(
          'PAIR_MACHINE_MISMATCH',
          `/pair/facts/${index}/${field}`,
          'Bilingual fact metadata must match.',
        );
      }
    }
  }
  return ok(normalized);
};

const validateTargets = async (lifecycleRoot, domainId, targets) => {
  if (!exactKeys(targets, pairLanguages)
    || pairLanguages.some((language) => !isNonEmptyString(targets[language]))) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_INVALID',
      '/targets',
      'Canonical bilingual targets are required.',
    );
  }
  if (targets.en === targets['zh-CN']) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_DUPLICATE',
      '/targets',
      'Bilingual capability targets must differ.',
    );
  }
  try {
    await Promise.all(pairLanguages.map((language) => resolveInside(lifecycleRoot, targets[language])));
  } catch (error) {
    if (stableWriteCodes.has(error?.code)) {
      return materializationFailure(error.code, `/targets`, 'Capability target is not bounded.');
    }
    throw error;
  }
  const existingTargets = await Promise.all(
    pairLanguages.map((language) => fileState(join(lifecycleRoot, targets[language]))),
  );
  if (existingTargets.some(Boolean)) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_DUPLICATE',
      '/targets',
      'Capability target is already occupied.',
    );
  }
  const expected = {
    en: `knowledge/${domainId}-en.md`,
    'zh-CN': `knowledge/${domainId}.md`,
  };
  if (!same(targets, expected)) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_INVALID',
      '/targets',
      'Capability targets must use the canonical fixed-root locators.',
    );
  }
  return ok(targets);
};

const indexContent = (existing, map, language) => {
  const heading = language === 'en' ? '## Confirmed domains' : '## 已确认领域';
  const headingIndex = existing.indexOf(`${heading}\n`);
  if (headingIndex === -1 || !existing.startsWith('<!--')) {
    const error = new Error('Existing generated index is invalid.');
    error.code = 'MATERIALIZATION_INDEX_INVALID';
    throw error;
  }
  const prefix = existing.slice(0, headingIndex + heading.length + 1);
  const lines = map.domains.map((domain) => {
    const description = `${domain.label[language]}: ${domain.purpose[language]}`;
    if (domain.domain_state !== 'materialized') return `- \`${domain.id}\` — ${description}`;
    return `- [\`${domain.id}\`](${domain.paired_assets[language]}) — ${description}`;
  });
  return `${prefix}\n${lines.join('\n')}\n`;
};

const validateRenderedDocument = (source) => {
  const frontmatter = parseFrontmatter(source);
  if (!frontmatter.ok) return frontmatter;
  const facts = parseFactBlocks(source);
  if (!facts.ok) return facts;
  const sectionCount = [...frontmatter.value.body.matchAll(/^## [^\n]+$/gm)].length;
  return sectionCount === 8 && facts.value.length > 0
    ? ok(source)
    : materializationFailure(
      'MATERIALIZATION_DOCUMENT_INVALID',
      '/sections',
      'Capability document requires eight sections and durable facts.',
    );
};

const validateIndex = (source, expected, map, language) => {
  if (source !== expected || !source.endsWith('\n')) {
    return materializationFailure(
      'MATERIALIZATION_INDEX_INVALID',
      `/INDEX${language === 'en' ? '-en' : ''}.md`,
      'Generated capability index is invalid.',
    );
  }
  for (const domain of map.domains) {
    if (!source.includes(`\`${domain.id}\``)) {
      return materializationFailure(
        'MATERIALIZATION_INDEX_INVALID',
        '/',
        'Generated capability index is incomplete.',
      );
    }
  }
  return ok(source);
};

const inspectCandidate = async ({
  lifecycleRoot,
  expectedMap,
  expectedEnglishIndex,
  expectedChineseIndex,
}) => {
  try {
    const [map, pending, englishIndex, chineseIndex, knowledgeState, deliveryState] = await Promise.all([
      readJson(join(lifecycleRoot, 'project-map.json')),
      readJson(join(lifecycleRoot, 'pending-changes.json')),
      readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
      readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
      fileState(join(lifecycleRoot, 'knowledge')),
      fileState(join(lifecycleRoot, 'delivery')),
    ]);
    if (!same(map, expectedMap)
      || englishIndex !== expectedEnglishIndex
      || chineseIndex !== expectedChineseIndex
      || !knowledgeState?.isDirectory()
      || knowledgeState.isSymbolicLink()
      || !deliveryState?.isDirectory()
      || deliveryState.isSymbolicLink()) return false;
    const mapValidation = validateJson('project-map', map);
    const pendingValidation = validateJson('pending-changes', pending);
    if (!mapValidation.ok || !pendingValidation.ok) return false;
    for (const domain of map.domains.filter(({ domain_state: state }) => state === 'materialized')) {
      const pairValidation = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        map,
      );
      if (!pairValidation.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const candidateError = () => {
  const error = new Error('Complete materialization candidate validation failed.');
  error.code = 'MATERIALIZATION_WRITE_FAILED';
  return error;
};

const requireCandidate = async (options) => {
  if (!await inspectCandidate(options)) throw candidateError();
};

const asWriteFailure = (error) => materializationFailure(
  stableWriteCodes.has(error?.code) ? error.code : 'MATERIALIZATION_WRITE_FAILED',
  '/',
  'Capability materialization could not be completed.',
);

const validateInputShape = (input) => {
  const required = [
    'root',
    'domain_id',
    'baseline',
    'knowledge_state',
    'owner_id',
    'dependency_ids',
    'authoritative_evidence_refs',
    'implementation_refs',
    'verification_refs',
    'targets',
    'pair',
  ];
  const allowed = new Set([...required, 'approval_ref']);
  if (!isRecord(input)
    || required.some((field) => !Object.hasOwn(input, field))
    || Object.keys(input).some((field) => !allowed.has(field))
    || typeof input.root !== 'string'
    || !isAbsolute(input.root)
    || !isId(input.domain_id)
    || !isNonEmptyString(input.baseline)
    || !['current', 'proposed'].includes(input.knowledge_state)
    || !isId(input.owner_id)
    || !orderedUniqueStrings(input.dependency_ids, { allowEmpty: true })
    || !orderedUniqueStrings(input.authoritative_evidence_refs)
    || !orderedUniqueStrings(input.implementation_refs, { allowEmpty: true })
    || !orderedUniqueStrings(input.verification_refs, { allowEmpty: true })) {
    return materializationFailure(
      'MATERIALIZATION_INPUT_INVALID',
      '/arguments',
      'Complete canonical materialization inputs are required.',
    );
  }
  if (input.knowledge_state === 'current' && !isNonEmptyString(input.approval_ref)) {
    return materializationFailure(
      'MATERIALIZATION_APPROVAL_REQUIRED',
      '/approval_ref',
      'Explicit user approval is required for new current truth.',
    );
  }
  if (input.knowledge_state === 'current'
    && (input.implementation_refs.length === 0 || input.verification_refs.length === 0)) {
    return materializationFailure(
      'MATERIALIZATION_EVIDENCE_REQUIRED',
      '/verification_refs',
      'Current truth requires implementation and verification references.',
    );
  }
  if ([...input.implementation_refs, ...input.verification_refs]
    .some((reference) => !input.authoritative_evidence_refs.includes(reference))) {
    return materializationFailure(
      'MATERIALIZATION_EVIDENCE_REQUIRED',
      '/authoritative_evidence_refs',
      'Implementation and verification references must belong to the authoritative evidence set.',
    );
  }
  return ok(input);
};

/**
 * Materializes one bilingual capability under the accepted sole-writer boundary.
 * The lifecycle root is cloned and validated before a root-level visibility swap.
 */
export async function materializeCapability(input, operations = {}) {
  const shapeResult = validateInputShape(input);
  if (!shapeResult.ok) return shapeResult;

  const lifecycleRoot = resolve(input.root, 'docs/project-lifecycle');
  const docsRoot = resolve(input.root, 'docs');
  let map;
  let englishIndexSource;
  let chineseIndexSource;
  try {
    const rootStat = await fileState(lifecycleRoot);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      return materializationFailure(
        'MATERIALIZATION_ROOT_INVALID',
        '/',
        'A regular bootstrapped lifecycle root is required.',
      );
    }
    [map, englishIndexSource, chineseIndexSource] = await Promise.all([
      readJson(join(lifecycleRoot, 'project-map.json')),
      readFile(join(lifecycleRoot, 'INDEX-en.md'), 'utf8'),
      readFile(join(lifecycleRoot, 'INDEX.md'), 'utf8'),
    ]);
  } catch {
    return materializationFailure(
      'MATERIALIZATION_ROOT_INVALID',
      '/',
      'A complete bootstrapped lifecycle root is required.',
    );
  }
  const mapValidation = validateJson('project-map', map);
  if (!mapValidation.ok) return mapValidation;

  const node = map.domains.find(({ id }) => id === input.domain_id);
  if (!node) {
    return materializationFailure(
      'REFERENCE_MISSING',
      '/domain_id',
      'Capability domain is absent from the project map.',
    );
  }
  if (node.domain_state !== 'confirmed') {
    return materializationFailure(
      'MATERIALIZATION_NODE_NOT_CONFIRMED',
      '/domain_id',
      'Only a confirmed domain may be materialized.',
    );
  }
  if (!map.domains.some(({ id }) => id === input.owner_id)) {
    return materializationFailure(
      'REFERENCE_MISSING',
      '/owner_id',
      'Canonical owner is absent from the project map.',
    );
  }
  const targetOwner = map.domains.find((domain) => domain.id !== input.domain_id
    && domain.paired_assets
    && pairLanguages.some((language) => (
      Object.values(input.targets).includes(domain.paired_assets[language])
    )));
  if (targetOwner) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_DUPLICATE',
      '/targets',
      'Capability target locator already belongs to another domain.',
    );
  }
  const declaredDependencies = node.relationships
    .filter(({ kind }) => kind === 'depends_on')
    .map(({ target_id: targetId }) => targetId)
    .sort(compareCodePoints);
  if (!same(input.dependency_ids, declaredDependencies)) {
    return materializationFailure(
      'MATERIALIZATION_DEPENDENCY_MISSING',
      '/dependency_ids',
      'Materialization must declare every routed dependency and no undeclared dependency.',
    );
  }

  const pairResult = validatePairInput(
    input.pair,
    input.authoritative_evidence_refs,
    input.baseline,
  );
  if (!pairResult.ok) return pairResult;
  const targetResult = await validateTargets(lifecycleRoot, input.domain_id, input.targets);
  if (!targetResult.ok) return targetResult;

  let templates;
  try {
    templates = await Promise.all([
      readFile(englishTemplateUrl, 'utf8'),
      readFile(chineseTemplateUrl, 'utf8'),
    ]);
  } catch {
    return materializationFailure(
      'MATERIALIZATION_TEMPLATE_INVALID',
      '/',
      'Capability templates are unavailable.',
    );
  }
  const pairedAsset = basename(input.targets['zh-CN']);
  let englishDocument;
  let chineseDocument;
  try {
    englishDocument = renderDocument({
      template: templates[0],
      domainId: input.domain_id,
      knowledgeState: input.knowledge_state,
      pairedAsset,
      baseline: input.baseline,
      implementationRefs: input.implementation_refs,
      verificationRefs: input.verification_refs,
      document: pairResult.value.en,
      language: 'en',
      ownerId: input.owner_id,
      dependencyIds: input.dependency_ids,
      approvalRef: input.approval_ref,
    });
    chineseDocument = renderDocument({
      template: templates[1],
      domainId: input.domain_id,
      knowledgeState: input.knowledge_state,
      pairedAsset,
      baseline: input.baseline,
      implementationRefs: input.implementation_refs,
      verificationRefs: input.verification_refs,
      document: pairResult.value['zh-CN'],
      language: 'zh-CN',
      ownerId: input.owner_id,
      dependencyIds: input.dependency_ids,
      approvalRef: input.approval_ref,
    });
  } catch {
    return materializationFailure(
      'MATERIALIZATION_TEMPLATE_INVALID',
      '/',
      'Capability templates are invalid.',
    );
  }

  for (const document of [englishDocument, chineseDocument]) {
    const validation = validateRenderedDocument(document);
    if (!validation.ok) return validation;
  }

  const candidateMap = clone(map);
  const candidateNode = candidateMap.domains.find(({ id }) => id === input.domain_id);
  candidateNode.domain_state = 'materialized';
  candidateNode.paired_assets = clone(input.targets);
  candidateNode.baseline = input.baseline;
  candidateNode.evidence_refs = [...new Set([
    ...candidateNode.evidence_refs,
    ...input.authoritative_evidence_refs,
  ])].sort(compareCodePoints);
  const candidateMapValidation = validateJson('project-map', candidateMap);
  if (!candidateMapValidation.ok) return candidateMapValidation;

  let englishIndex;
  let chineseIndex;
  try {
    englishIndex = indexContent(englishIndexSource, candidateMap, 'en');
    chineseIndex = indexContent(chineseIndexSource, candidateMap, 'zh-CN');
  } catch {
    return materializationFailure(
      'MATERIALIZATION_INDEX_INVALID',
      '/',
      'Existing generated indexes cannot be regenerated.',
    );
  }

  const writeArtifact = operations.atomicWriteValidated ?? atomicWriteValidated;
  const publish = operations.rename ?? rename;
  const afterPublish = operations.afterPublish ?? (async () => {});
  let stagingRoot;
  let backupRoot;
  let originalBackedUp = false;
  let candidatePublished = false;
  try {
    stagingRoot = await mkdtemp(join(docsRoot, '.project-lifecycle-materialize-stage-'));
    await cp(lifecycleRoot, stagingRoot, { recursive: true, force: false });
    await writeArtifact({
      root: stagingRoot,
      target: input.targets.en,
      content: englishDocument,
      validate: async (source) => validateRenderedDocument(source),
    });
    await writeArtifact({
      root: stagingRoot,
      target: input.targets['zh-CN'],
      content: chineseDocument,
      validate: async (source) => validateRenderedDocument(source),
    });
    await writeArtifact({
      root: stagingRoot,
      target: 'project-map.json',
      content: jsonContent(candidateMap),
      validate: async (source) => {
        try {
          return validateJson('project-map', JSON.parse(source));
        } catch {
          return materializationFailure('SCHEMA_INVALID', '/', 'Invalid project-map candidate.');
        }
      },
    });
    await writeArtifact({
      root: stagingRoot,
      target: 'INDEX-en.md',
      content: englishIndex,
      validate: async (source) => validateIndex(source, englishIndex, candidateMap, 'en'),
    });
    await writeArtifact({
      root: stagingRoot,
      target: 'INDEX.md',
      content: chineseIndex,
      validate: async (source) => validateIndex(source, chineseIndex, candidateMap, 'zh-CN'),
    });
    const expectedCandidate = {
      expectedMap: candidateMap,
      expectedEnglishIndex: englishIndex,
      expectedChineseIndex: chineseIndex,
      targets: input.targets,
    };
    await requireCandidate({ lifecycleRoot: stagingRoot, ...expectedCandidate });

    backupRoot = await mkdtemp(join(docsRoot, '.project-lifecycle-materialize-backup-'));
    await rmdir(backupRoot);
    await publish(lifecycleRoot, backupRoot);
    const [postBackupLifecycle, postBackupRoot] = await Promise.all([
      fileState(lifecycleRoot),
      fileState(backupRoot),
    ]);
    originalBackedUp = postBackupLifecycle === null
      && postBackupRoot?.isDirectory()
      && !postBackupRoot.isSymbolicLink();
    if (!originalBackedUp) throw candidateError();
    await publish(stagingRoot, lifecycleRoot);
    const [postPublishLifecycle, postPublishStage] = await Promise.all([
      fileState(lifecycleRoot),
      fileState(stagingRoot),
    ]);
    candidatePublished = postPublishLifecycle?.isDirectory()
      && !postPublishLifecycle.isSymbolicLink()
      && postPublishStage === null;
    if (!candidatePublished) throw candidateError();
    stagingRoot = null;
    await requireCandidate({ lifecycleRoot, ...expectedCandidate });
    await afterPublish({ lifecycleRoot });
    await rm(backupRoot, { recursive: true, force: true });
    backupRoot = null;
    return ok({
      baseline: input.baseline,
      domain_id: input.domain_id,
      knowledge_state: input.knowledge_state,
      status: 'materialized',
    });
  } catch (error) {
    let restoreError;
    if (originalBackedUp && backupRoot) {
      try {
        const currentState = await fileState(lifecycleRoot);
        if (currentState) await rm(lifecycleRoot, { recursive: true, force: true });
        await rename(backupRoot, lifecycleRoot);
        const [restoredState, remainingBackup] = await Promise.all([
          fileState(lifecycleRoot),
          fileState(backupRoot),
        ]);
        if (!restoredState?.isDirectory() || restoredState.isSymbolicLink() || remainingBackup) {
          throw candidateError();
        }
        backupRoot = null;
      } catch (candidateRestoreError) {
        restoreError = candidateRestoreError;
      }
    }
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (backupRoot && !restoreError) await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
    if (restoreError) {
      return materializationFailure(
        'MATERIALIZATION_RESTORE_FAILED',
        '/',
        'Capability materialization failed and the original root requires recovery.',
      );
    }
    return asWriteFailure(error);
  }
}
