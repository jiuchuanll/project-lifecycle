import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';
import { pairForDomain, planKnowledgeLayout } from './layout-planner.mjs';
import {
  applyLayoutTransaction,
  finalizeRetainedLayout,
  inspectLifecycleTree,
  rollbackRetainedLayout,
} from './layout-transaction.mjs';

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

const inside = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === ''
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
};

const boundedDirectory = async (projectRoot, path) => {
  const state = await lstat(path);
  const real = await realpath(path);
  return state.isDirectory()
    && !state.isSymbolicLink()
    && inside(projectRoot, real);
};

const resolveLifecyclePaths = async (inputRoot) => {
  const lexicalRoot = resolve(inputRoot);
  const lexicalRootState = await lstat(lexicalRoot);
  const projectRoot = await realpath(lexicalRoot);
  if (!lexicalRootState.isDirectory() || lexicalRootState.isSymbolicLink()) {
    const error = new Error('Project root must not be a symlink.');
    error.code = 'PATH_SYMLINK_ESCAPE';
    throw error;
  }
  const docsRoot = await resolveInside(projectRoot, 'docs');
  if (!await boundedDirectory(projectRoot, docsRoot)) {
    const error = new Error('Docs root must be a bounded regular directory.');
    error.code = 'PATH_SYMLINK_ESCAPE';
    throw error;
  }
  const lifecycleRoot = await resolveInside(projectRoot, 'docs/project-lifecycle');
  if (!await boundedDirectory(projectRoot, lifecycleRoot)) {
    const error = new Error('Lifecycle root must be a bounded regular directory.');
    error.code = 'PATH_SYMLINK_ESCAPE';
    throw error;
  }
  return {
    projectRoot,
    docsRoot: await realpath(docsRoot),
    lifecycleRoot: await realpath(lifecycleRoot),
  };
};

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
      ['State the owned outcome, included and excluded scope, and the distinction from parent and peer domains.', document.purpose_and_current_boundary],
      ['Add only durable facts. For each independently addressable fact, retain its stable ID and revision, current statement, evidence references, verification baseline, and explicit limits. Do not fill missing knowledge with placeholder prose.', factContent(document.facts, language)],
      ['Describe only the containment, horizontal collaboration, shared data, interfaces, and constraints that affect this capability.', document.system_and_data_relationships],
      ['List the smallest stable implementation and resource entry points; link instead of duplicating implementation prose.', document.implementation_and_resource_map],
      ['State verified coverage, supporting checks, and any unmet semantic quality gate.', document.quality_state],
      ['Identify the canonical owner and declared major dependencies used for routing.', `${ownerLine}\n\n${dependencyLines}\n\n${document.dependencies}`],
      ['State evidence-bounded limits, confidence limits, known extension seams, unknowns, and unresolved risks.', bulletContent(document.unknowns)],
      ['Summarize authoritative evidence and human decisions without copying Feedback, PRD, test-report, delivery, or historical bodies.', `${approvalLine}\n\n${document.provenance}`],
    ]
    : [
      ['能力标题', document.title],
      ['说明该领域负责的结果、包含与排除范围，以及它与父级和同级领域的区别。', document.purpose_and_current_boundary],
      ['仅添加持久事实。对于每个可独立引用的事实，保留稳定 ID 与修订号、当前陈述、证据引用、验证基线和明确限制。不要用占位文字填补缺失知识。', factContent(document.facts, language)],
      ['只描述影响该能力的包含关系、横向协作、共享数据、接口和约束。', document.system_and_data_relationships],
      ['列出最小且稳定的实现与资源入口；通过链接而不是复制实现说明。', document.implementation_and_resource_map],
      ['说明已验证覆盖、支持性检查以及尚未满足的语义质量门。', document.quality_state],
      ['标明规范所有者以及用于路由的已声明主要依赖。', `${ownerLine}\n\n${dependencyLines}\n\n${document.dependencies}`],
      ['说明由证据限定的限制、置信边界、已知扩展接缝、未知项和未解决风险。', bulletContent(document.unknowns)],
      ['概述权威证据与人工决策，不复制 Feedback、PRD、测试报告、交付文档或历史正文。', `${approvalLine}\n\n${document.provenance}`],
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

const validateTargets = async (lifecycleRoot, targets, expected) => {
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
  if (!same(targets, expected)) {
    return materializationFailure(
      'MATERIALIZATION_TARGET_INVALID',
      '/targets',
      'Capability targets must match the canonical recursive layout.',
    );
  }
  return ok(targets);
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

const validateIndex = (source, expected, language) => {
  if (source !== expected || !source.endsWith('\n')) {
    return materializationFailure(
      'MATERIALIZATION_INDEX_INVALID',
      `/INDEX${language === 'en' ? '-en' : ''}.md`,
      'Generated capability index is invalid.',
    );
  }
  return ok(source);
};

const inspectCandidate = async ({
  lifecycleRoot,
  expectedMap,
  expectedFiles,
  expectedDirectories,
  repositoryId = null,
}) => {
  try {
    if (repositoryId === null) {
      const [map, pending, deliveryState] = await Promise.all([
        readJson(join(lifecycleRoot, 'project-map.json')),
        readJson(join(lifecycleRoot, 'pending-changes.json')),
        fileState(join(lifecycleRoot, 'delivery')),
      ]);
      if (!same(map, expectedMap)
        || !deliveryState?.isDirectory()
        || deliveryState.isSymbolicLink()
        || !validateJson('project-map', map).ok
        || !validateJson('pending-changes', pending).ok) return false;
    }
    for (const directory of expectedDirectories) {
      const state = await fileState(join(lifecycleRoot, directory));
      if (!state?.isDirectory() || state.isSymbolicLink()) return false;
    }
    for (const file of expectedFiles) {
      const state = await fileState(join(lifecycleRoot, file.locator));
      if (!state?.isFile() || state.isSymbolicLink()
        || await readFile(join(lifecycleRoot, file.locator), 'utf8') !== file.content) return false;
    }
    for (const domain of expectedMap.domains.filter(({ domain_state: state, paired_assets: pair }) => (
      state === 'materialized' && pair.repository_id === repositoryId
    ))) {
      const pairValidation = await validateBilingualPair(
        join(lifecycleRoot, domain.paired_assets.en),
        join(lifecycleRoot, domain.paired_assets['zh-CN']),
        expectedMap,
      );
      if (!pairValidation.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
};

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
  const allowed = new Set([...required, 'approval_ref', 'repository_roots']);
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
  if (Object.hasOwn(input, 'repository_roots') && (!isRecord(input.repository_roots)
    || Object.values(input.repository_roots).some((root) => typeof root !== 'string' || !isAbsolute(root)))) {
    return materializationFailure('MATERIALIZATION_INPUT_INVALID', '/repository_roots', 'Repository roots must be explicit absolute project directories.');
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

  let lifecycleRoot;
  let originalFingerprint;
  try {
    ({ lifecycleRoot } = await resolveLifecyclePaths(input.root));
    const inspected = await inspectLifecycleTree({ repositoryRoot: input.root });
    if (!inspected.ok) throw Object.assign(new Error('Invalid lifecycle root.'), { code: inspected.errors[0].code });
    originalFingerprint = inspected.value.fingerprint;
  } catch (error) {
    return materializationFailure(
      stableWriteCodes.has(error?.code) ? error.code : 'MATERIALIZATION_ROOT_INVALID',
      '/',
      'A bounded regular lifecycle root is required.',
    );
  }
  let map;
  try {
    const rootStat = await fileState(lifecycleRoot);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      return materializationFailure(
        'MATERIALIZATION_ROOT_INVALID',
        '/',
        'A regular bootstrapped lifecycle root is required.',
      );
    }
    map = await readJson(join(lifecycleRoot, 'project-map.json'));
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
  if (input.owner_id !== input.domain_id) {
    return materializationFailure(
      'MATERIALIZATION_OWNER_MISMATCH',
      '/owner_id',
      'Task 3 v1 materialization requires the domain to own its capability asset.',
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
  const candidateMap = clone(map);
  if (input.knowledge_state === 'current') candidateMap.knowledge_baseline = input.baseline;
  const candidateNode = candidateMap.domains.find(({ id }) => id === input.domain_id);
  candidateNode.domain_state = 'materialized';
  candidateNode.baseline = input.baseline;
  candidateNode.evidence_refs = [...new Set([
    ...candidateNode.evidence_refs,
    ...input.authoritative_evidence_refs,
  ])].sort(compareCodePoints);
  const planned = planKnowledgeLayout({ map: candidateMap });
  if (!planned.ok) return planned;
  const canonicalPair = pairForDomain(planned.value, input.domain_id);
  const ownerRepositoryId = canonicalPair.repository_id;
  let ownerRoots = { projectRoot: input.root, lifecycleRoot };
  if (ownerRepositoryId !== null) {
    const ownerRoot = input.repository_roots?.[ownerRepositoryId];
    if (!isNonEmptyString(ownerRoot)) {
      return materializationFailure('MATERIALIZATION_ROOT_INVALID', `/repository_roots/${ownerRepositoryId}`, 'The owning repository requires one explicit local root.');
    }
    try {
      ownerRoots = await resolveLifecyclePaths(ownerRoot);
    } catch (error) {
      return materializationFailure(
        stableWriteCodes.has(error?.code) ? error.code : 'MATERIALIZATION_ROOT_INVALID',
        `/repository_roots/${ownerRepositoryId}`,
        'The owning repository root is invalid.',
      );
    }
  }
  const expectedTargets = { en: canonicalPair.en, 'zh-CN': canonicalPair['zh-CN'] };
  const targetResult = await validateTargets(ownerRoots.lifecycleRoot, input.targets, expectedTargets);
  if (!targetResult.ok) return targetResult;
  candidateNode.paired_assets = canonicalPair;
  const candidateMapValidation = validateJson('project-map', candidateMap);
  if (!candidateMapValidation.ok) return candidateMapValidation;

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

  const repositoryIds = ownerRepositoryId === null ? [null] : [ownerRepositoryId, null];
  const rootsByRepository = new Map([[null, { projectRoot: input.root, lifecycleRoot }], [ownerRepositoryId, ownerRoots]]);
  const indexesByRepository = new Map();
  const fingerprints = new Map([[null, originalFingerprint]]);
  for (const repositoryId of repositoryIds) {
    const repositoryRoots = rootsByRepository.get(repositoryId);
    const indexes = await generateIndexesFromRoot({
      map: candidateMap,
      lifecycleRoot: repositoryRoots.lifecycleRoot,
      repository_id: repositoryId,
      overlays: repositoryId === ownerRepositoryId ? {
        [input.targets.en]: englishDocument,
        [input.targets['zh-CN']]: chineseDocument,
      } : {},
    });
    if (!indexes.ok) {
      return materializationFailure('MATERIALIZATION_INDEX_INVALID', '/', 'Generated indexes cannot be rebuilt from validated navigation Frontmatter.');
    }
    indexesByRepository.set(repositoryId, indexes.value.files);
    if (!fingerprints.has(repositoryId)) {
      const inspected = await inspectLifecycleTree({ repositoryRoot: repositoryRoots.projectRoot });
      if (!inspected.ok) return materializationFailure('MATERIALIZATION_ROOT_INVALID', '/', 'The owning repository changed before publication.');
      fingerprints.set(repositoryId, inspected.value.fingerprint);
    }
  }

  const retained = [];
  let cleanupPending = false;
  const recoveryArtifacts = [];
  for (const repositoryId of repositoryIds) {
    const repositoryRoots = rootsByRepository.get(repositoryId);
    const expectedFiles = indexesByRepository.get(repositoryId);
    const expectedDirectories = [...new Set([
      ...(repositoryId === null ? ['delivery'] : []),
      ...planned.value.directories
        .filter(({ repository_id: id }) => id === repositoryId)
        .map(({ locator }) => locator),
    ])].sort(compareCodePoints);
    const candidateFiles = [
      ...(repositoryId === ownerRepositoryId ? [{
        repository_id: repositoryId,
        locator: input.targets.en,
        content: englishDocument,
        validate: async (source) => validateRenderedDocument(source),
      }, {
        repository_id: repositoryId,
        locator: input.targets['zh-CN'],
        content: chineseDocument,
        validate: async (source) => validateRenderedDocument(source),
      }] : []),
      ...(repositoryId === null ? [{
        repository_id: null,
        locator: 'project-map.json',
        content: jsonContent(candidateMap),
        validate: async (source) => {
          try { return validateJson('project-map', JSON.parse(source)); } catch { return materializationFailure('SCHEMA_INVALID', '/', 'Invalid project-map candidate.'); }
        },
      }] : []),
      ...expectedFiles.map((file) => ({
        repository_id: repositoryId,
        locator: file.locator,
        content: file.content,
        validate: async (source) => validateIndex(source, file.content, file.language),
      })),
    ];
    const published = await applyLayoutTransaction({
      repositoryRoot: repositoryRoots.projectRoot,
      expectedFingerprint: fingerprints.get(repositoryId),
      candidateFiles,
      candidateDirectories: expectedDirectories,
      deleteLocators: [],
      validateCandidate: async ({ lifecycleRoot: candidateRoot }) => ({
        ok: await inspectCandidate({
          lifecycleRoot: candidateRoot,
          expectedMap: candidateMap,
          expectedFiles,
          expectedDirectories,
          repositoryId,
        }),
        errors: [],
      }),
    }, {
      ...operations,
      retainBackup: repositoryId !== null,
      afterPublish: async (context) => {
        await operations.afterPublish?.({ ...context, repository_id: repositoryId });
        await operations.afterRepositoryPublish?.({ ...context, repository_id: repositoryId });
      },
    });
    if (!published.ok) {
      for (const prior of retained.reverse()) {
        const restored = await rollbackRetainedLayout(prior, operations);
        if (!restored.ok) return materializationFailure('MATERIALIZATION_RESTORE_FAILED', '/', 'The owning repository could not be restored.');
      }
      const error = published.errors[0];
      if (error.code === 'LAYOUT_RESTORE_FAILED') return materializationFailure('MATERIALIZATION_RESTORE_FAILED', error.path, error.message);
      return materializationFailure(stableWriteCodes.has(error.code) ? error.code : 'MATERIALIZATION_WRITE_FAILED', '/', 'Capability materialization could not be completed.');
    }
    if (published.value.retained_publication) retained.push(published.value);
    else {
      cleanupPending ||= published.value.cleanup_pending;
      recoveryArtifacts.push(...published.value.recovery_artifacts);
    }
  }
  for (const prior of retained) {
    const finalized = await finalizeRetainedLayout(prior, operations);
    if (!finalized.ok) {
      cleanupPending = true;
      recoveryArtifacts.push('backup');
    }
  }
  return ok({
    baseline: input.baseline,
    domain_id: input.domain_id,
    knowledge_state: input.knowledge_state,
    status: 'materialized',
    cleanup_state: cleanupPending ? 'pending' : 'complete',
    ...(recoveryArtifacts.length > 0 ? { recovery_artifacts: [...new Set(recoveryArtifacts)] } : {}),
  });
}
