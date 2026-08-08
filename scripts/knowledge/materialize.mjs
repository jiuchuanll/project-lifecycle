import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { atomicWriteValidated } from '../lib/atomic-write.mjs';
import { validateBilingualPair } from '../lib/bilingual-pair.mjs';
import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { createError } from '../lib/errors.mjs';
import { parseFactBlocks } from '../lib/fact-blocks.mjs';
import { parseFrontmatter } from '../lib/markdown.mjs';
import { fail, ok } from '../lib/result.mjs';
import { resolveInside } from '../lib/safe-path.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { generateIndexesFromRoot } from './generate-indexes.mjs';

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

const directoryFingerprint = async (root) => {
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const locator = prefix ? `${prefix}/${child.name}` : child.name;
      const state = await lstat(path);
      if (state.isDirectory() && !state.isSymbolicLink()) {
        entries.push({ locator: `${locator}/`, type: 'directory' });
        await visit(path, locator);
      } else if (state.isFile()) {
        const hash = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.push({ locator, type: 'file', hash });
      } else if (state.isSymbolicLink()) {
        entries.push({ locator, type: 'symlink', target: await readlink(path) });
      } else {
        const error = new Error('Unsupported lifecycle filesystem entry.');
        error.code = 'MATERIALIZATION_ROOT_INVALID';
        throw error;
      }
    }
  };
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    const error = new Error('Lifecycle root must be a regular directory.');
    error.code = 'MATERIALIZATION_ROOT_INVALID';
    throw error;
  }
  await visit(root);
  return JSON.stringify(entries);
};

const fingerprintMatches = async (path, expected) => {
  try {
    return await directoryFingerprint(path) === expected;
  } catch {
    return false;
  }
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

const verifyOwnedTransactionDirectory = async (projectRoot, path) => {
  if (!await boundedDirectory(projectRoot, path)) {
    const error = new Error('Transaction directory escaped the project root.');
    error.code = 'PATH_SYMLINK_ESCAPE';
    throw error;
  }
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

const inspectTransitionState = async ({
  phase,
  projectRoot,
  lifecycleRoot,
  stagingRoot,
  backupRoot,
  originalFingerprint,
  expectedCandidate,
}) => {
  if (phase === 'backup-moved') {
    const [liveState, stageBounded, backupBounded, backupOriginal] = await Promise.all([
      fileState(lifecycleRoot),
      boundedDirectory(projectRoot, stagingRoot),
      boundedDirectory(projectRoot, backupRoot),
      fingerprintMatches(backupRoot, originalFingerprint),
    ]);
    return {
      ok: liveState === null && stageBounded && backupBounded && backupOriginal,
    };
  }
  if (phase === 'candidate-moved') {
    const [stageState, liveBounded, backupBounded, backupOriginal, liveCandidate] = await Promise.all([
      fileState(stagingRoot),
      boundedDirectory(projectRoot, lifecycleRoot),
      boundedDirectory(projectRoot, backupRoot),
      fingerprintMatches(backupRoot, originalFingerprint),
      inspectCandidate({ lifecycleRoot, ...expectedCandidate }),
    ]);
    return {
      ok: stageState === null
        && liveBounded
        && backupBounded
        && backupOriginal
        && liveCandidate,
    };
  }
  return { ok: false };
};

const recoveryArtifactLabels = async ({ lifecycleRoot, stagingRoot, backupRoot }) => {
  const labels = [];
  for (const [label, path] of [
    ['backup', backupRoot],
    ['live', lifecycleRoot],
    ['stage', stagingRoot],
  ]) {
    if (!path) continue;
    try {
      if (await fileState(path)) labels.push(label);
    } catch {
      labels.push(label);
    }
  }
  return labels;
};

const restoreFailure = async (paths) => {
  const artifacts = await recoveryArtifactLabels(paths);
  const label = artifacts.length > 0 ? artifacts.join(', ') : 'unknown';
  return materializationFailure(
    'MATERIALIZATION_RESTORE_FAILED',
    '/recovery',
    `Recovery required; preserved artifacts: ${label}.`,
  );
};

const cleanupOwnedStage = async ({ projectRoot, stagingRoot }) => {
  if (!stagingRoot || !await fileState(stagingRoot)) return;
  await verifyOwnedTransactionDirectory(projectRoot, stagingRoot);
  // The accepted original has already been verified live. This exact sibling is the
  // transaction-owned candidate stage, so it is neither original nor authoritative.
  await rm(stagingRoot, { recursive: true, force: true });
};

const reconcileOriginal = async ({
  projectRoot,
  lifecycleRoot,
  stagingRoot,
  backupRoot,
  originalFingerprint,
  expectedCandidate,
  restoreRename,
}) => {
  try {
    if (await fingerprintMatches(lifecycleRoot, originalFingerprint)) {
      await cleanupOwnedStage({ projectRoot, stagingRoot });
      return { ok: true };
    }

    const backupIsOriginal = backupRoot
      && await fingerprintMatches(backupRoot, originalFingerprint);
    if (!backupIsOriginal) {
      return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
    }
    await verifyOwnedTransactionDirectory(projectRoot, backupRoot);

    const liveState = await fileState(lifecycleRoot);
    if (liveState) {
      const liveIsCandidate = await inspectCandidate({ lifecycleRoot, ...expectedCandidate });
      const stageState = stagingRoot ? await fileState(stagingRoot) : null;
      if (!liveIsCandidate || stageState) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
      }
      // Do not delete a possibly recoverable live candidate. Move it back to its
      // transaction-owned stage locator so both original and candidate survive a
      // subsequent restore failure.
      await rename(lifecycleRoot, stagingRoot);
      if (await fileState(lifecycleRoot)
        || !await inspectCandidate({ lifecycleRoot: stagingRoot, ...expectedCandidate })) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
      }
    }

    try {
      await restoreRename(backupRoot, lifecycleRoot);
    } catch {
      // A rename can move and still reject. Trust the filesystem postcondition,
      // not the promise result.
      if (!await fingerprintMatches(lifecycleRoot, originalFingerprint)
        || await fileState(backupRoot)) {
        return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
      }
    }

    if (!await fingerprintMatches(lifecycleRoot, originalFingerprint)
      || await fileState(backupRoot)) {
      return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
    }
    await cleanupOwnedStage({ projectRoot, stagingRoot });
    return { ok: true };
  } catch {
    // Recovery failures preserve backup/stage/live as found. In particular, this
    // path never recursively removes backup or attempts speculative cleanup.
    return { ok: false, result: await restoreFailure({ lifecycleRoot, stagingRoot, backupRoot }) };
  }
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

  let projectRoot;
  let lifecycleRoot;
  let docsRoot;
  let originalFingerprint;
  try {
    ({ projectRoot, lifecycleRoot, docsRoot } = await resolveLifecyclePaths(input.root));
    originalFingerprint = await directoryFingerprint(lifecycleRoot);
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

  const indexes = await generateIndexesFromRoot({
    map: candidateMap,
    lifecycleRoot,
    overlays: {
      [input.targets.en]: englishDocument,
      [input.targets['zh-CN']]: chineseDocument,
    },
  });
  if (!indexes.ok) {
    return materializationFailure(
      'MATERIALIZATION_INDEX_INVALID',
      '/',
      'Generated indexes cannot be rebuilt from validated navigation Frontmatter.',
    );
  }
  const englishIndex = indexes.value.en;
  const chineseIndex = indexes.value['zh-CN'];

  const writeArtifact = operations.atomicWriteValidated ?? atomicWriteValidated;
  const publish = operations.rename ?? rename;
  const afterPublish = operations.afterPublish ?? (async () => {});
  const inspectTransition = operations.inspectTransition ?? inspectTransitionState;
  const restoreRename = operations.restoreRename ?? rename;
  const removeBackup = operations.removeBackup
    ?? ((path) => rm(path, { recursive: true, force: true }));
  let stagingRoot;
  let backupRoot;
  const expectedCandidate = {
    expectedMap: candidateMap,
    expectedEnglishIndex: englishIndex,
    expectedChineseIndex: chineseIndex,
  };
  try {
    stagingRoot = await mkdtemp(join(docsRoot, '.project-lifecycle-materialize-stage-'));
    await verifyOwnedTransactionDirectory(projectRoot, stagingRoot);
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
    await requireCandidate({ lifecycleRoot: stagingRoot, ...expectedCandidate });

    backupRoot = await mkdtemp(join(docsRoot, '.project-lifecycle-materialize-backup-'));
    await verifyOwnedTransactionDirectory(projectRoot, backupRoot);
    await rmdir(backupRoot);
    await publish(lifecycleRoot, backupRoot);
    const backupTransition = await inspectTransition({
      phase: 'backup-moved',
      projectRoot,
      lifecycleRoot,
      stagingRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
    });
    if (backupTransition?.ok !== true) throw candidateError();

    await publish(stagingRoot, lifecycleRoot);
    const candidateTransition = await inspectTransition({
      phase: 'candidate-moved',
      projectRoot,
      lifecycleRoot,
      stagingRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
    });
    if (candidateTransition?.ok !== true) throw candidateError();
    await requireCandidate({ lifecycleRoot, ...expectedCandidate });
    await afterPublish({ lifecycleRoot });

    // The candidate is now verified live and becomes authoritative. Only from this
    // point may the original backup be recursively cleaned. A partial cleanup never
    // triggers rollback through a backup that may no longer be intact.
    let cleanupComplete = false;
    try {
      await removeBackup(backupRoot);
    } catch {}
    try {
      cleanupComplete = await fileState(backupRoot) === null;
    } catch {}
    if (!cleanupComplete) {
      return ok({
        baseline: input.baseline,
        domain_id: input.domain_id,
        knowledge_state: input.knowledge_state,
        status: 'materialized',
        cleanup_state: 'pending',
        recovery_artifacts: ['backup'],
      });
    }
    backupRoot = null;
    return ok({
      baseline: input.baseline,
      domain_id: input.domain_id,
      knowledge_state: input.knowledge_state,
      status: 'materialized',
      cleanup_state: 'complete',
    });
  } catch (error) {
    const recovery = await reconcileOriginal({
      projectRoot,
      lifecycleRoot,
      stagingRoot,
      backupRoot,
      originalFingerprint,
      expectedCandidate,
      restoreRename,
    });
    if (!recovery.ok) return recovery.result;
    return asWriteFailure(error);
  }
}
