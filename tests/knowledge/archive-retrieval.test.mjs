import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildArchiveCatalog,
  validateArchiveCatalog,
} from '../../scripts/knowledge/archive-catalog.mjs';
import { resolveArchiveArtifacts } from '../../scripts/knowledge/archive-resolver.mjs';

const fixtureProject = new URL('../fixtures/knowledge/archive/project/', import.meta.url);
const locators = [
  'archive/delivery/prds/prd-wiki-layout-v1/architecture/architecture-wiki-v1-en.md',
  'archive/delivery/prds/prd-search-v1/prd-search-v1-en.md',
  'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
  'delivery/prds/prd-wiki-layout-v1/closure/closure-wiki-v1-en.md',
];
const artifactById = (catalog, id) => catalog.artifacts.find(({ artifact_id: artifactId }) => artifactId === id);

const withProject = async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-archive-'));
  await cp(fixtureProject, root, { recursive: true });
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const receipt = (overrides = {}) => ({
  schema_version: 1,
  receipt_id: 'archive-receipt-wiki',
  task_ref: 'task-wiki-regression',
  reason: 'REGRESSION',
  question: 'Which accepted layout behavior changed?',
  insufficiency_reason: 'Current knowledge and the closed summary omit the former acceptance detail.',
  artifact_ids: ['prd-wiki-layout-v1'],
  scope: { domain_ids: ['wiki-workspace'] },
  returned_artifacts: [],
  ...overrides,
});

const catalogFor = async (root, overrides = {}) => buildArchiveCatalog({
  root,
  delivery_locators: locators,
  ...overrides,
});

const archiveRequest = (root, catalog, overrides = {}) => ({
  root,
  catalog,
  receipt: receipt(),
  current_context_sufficient: false,
  closed_summary_sufficient: false,
  material_decision_changed: false,
  ...overrides,
});

test('builds a deterministic metadata-only catalog from validated map and retained delivery Frontmatter', async () => {
  await withProject(async (root) => {
    const reads = [];
    const result = await catalogFor(root, { operations: { onRead: (entry) => reads.push(entry) } });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.artifacts.map(({ artifact_id: id }) => id), [
      'architecture-wiki-v1',
      'closure-wiki-v1',
      'prd-search-v1',
      'prd-wiki-layout-v1',
    ]);
    const wikiPrd = artifactById(result.value, 'prd-wiki-layout-v1');
    assert.deepEqual(wikiPrd, {
      artifact_id: 'prd-wiki-layout-v1',
      retention_tier: 'archive',
      content_hash: wikiPrd.content_hash,
      project_id_at_creation: 'sample-project',
      current_project_id: 'sample-project',
      domain_ids: ['wiki-workspace'],
      locator: 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
    });
    assert.match(wikiPrd.content_hash, /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result.value), /BODY-SECRET|former accepted/u);
    assert.equal(reads.filter(({ section }) => section === 'artifact-hash').length, 4);
    assert.equal(validateArchiveCatalog(result.value).ok, true);
  });
});

test('defaults to zero archive reads when current knowledge or the closed summary is sufficient', async () => {
  for (const sufficiency of [
    { current_context_sufficient: true, closed_summary_sufficient: false },
    { current_context_sufficient: false, closed_summary_sufficient: true },
  ]) {
    const reads = [];
    const result = await resolveArchiveArtifacts({
      root: '/does/not/exist',
      catalog: null,
      receipt: null,
      material_decision_changed: false,
      ...sufficiency,
    }, { onRead: (entry) => reads.push(entry) });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.artifacts, []);
    assert.deepEqual(result.value.read_log, []);
    assert.equal(result.value.reuse_record, null);
    assert.equal(result.value.durable_evidence_recommendation, null);
    assert.deepEqual(reads, []);
  }
});

test('returns only an exact receipt-approved archive artifact and logs the exact body read', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const reads = [];
    const result = await resolveArchiveArtifacts(
      archiveRequest(root, catalog),
      { onRead: (entry) => reads.push(entry) },
    );

    assert.equal(result.ok, true);
    assert.equal(result.value.artifacts.length, 1);
    assert.equal(result.value.artifacts[0].artifact_id, 'prd-wiki-layout-v1');
    assert.equal(result.value.artifacts[0].locator, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md');
    assert.match(result.value.artifacts[0].content, /ARCHIVE-WIKI-BODY-SECRET/u);
    assert.equal(result.value.artifacts[0].reused, false);
    assert.deepEqual(result.value.read_log, reads);
    assert.deepEqual(reads, [{
      artifact_id: 'prd-wiki-layout-v1',
      locator: 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
      content_hash: artifactById(catalog, 'prd-wiki-layout-v1').content_hash,
      outcome: 'returned',
    }]);
    assert.deepEqual(result.value.reuse_record, {
      task_ref: 'task-wiki-regression',
      receipt_id: 'archive-receipt-wiki',
      receipt_revision: 1,
      scope: { domain_ids: ['wiki-workspace'] },
      returned_artifacts: [{
        artifact_id: 'prd-wiki-layout-v1',
        content_hash: artifactById(catalog, 'prd-wiki-layout-v1').content_hash,
      }],
    });
    assert.equal(result.value.durable_evidence_recommendation, null);
  });
});

test('returns one archived owner child only after its exact receipt authorizes the artifact ID', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const result = await resolveArchiveArtifacts(archiveRequest(root, catalog, {
      receipt: receipt({ artifact_ids: ['architecture-wiki-v1'] }),
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.artifacts.map(({ artifact_id: id }) => id), ['architecture-wiki-v1']);
    assert.match(result.value.artifacts[0].content, /ARCHIVE-WIKI-ARCHITECTURE-SECRET/u);
    assert.equal(
      result.value.artifacts[0].locator,
      'archive/delivery/prds/prd-wiki-layout-v1/architecture/architecture-wiki-v1-en.md',
    );
  });
});

test('rejects invalid reasons, glob targets, directory tokens, and unbounded artifact lists before body reads', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const cases = [
      receipt({ reason: 'GENERAL_CONTEXT' }),
      receipt({ artifact_ids: ['archive-*'] }),
      receipt({ artifact_ids: ['archive'] }),
      receipt({ artifact_ids: Array.from({ length: 21 }, (_, index) => `archive-${index}`) }),
    ];
    for (const invalidReceipt of cases) {
      const reads = [];
      const result = await resolveArchiveArtifacts(
        archiveRequest(root, catalog, { receipt: invalidReceipt }),
        { onRead: (entry) => reads.push(entry) },
      );
      assert.equal(result.ok, false);
      assert.deepEqual(reads, []);
    }
  });
});

test('rejects unsafe catalog locators and symlink artifacts without reading their bodies', async () => {
  for (const locator of [
    '../archive.md',
    '/tmp/archive.md',
    'C:\\archive.md',
    'delivery\\archive.md',
    'delivery/*.md',
    'delivery/archive/',
    'delivery/nested/archive.md',
  ]) {
    await withProject(async (root) => {
      const reads = [];
      const result = await buildArchiveCatalog({
        root,
        delivery_locators: [locator],
        operations: { onRead: (entry) => reads.push(entry) },
      });
      assert.equal(result.ok, false, locator);
      assert.deepEqual(reads, [], locator);
    });
  }

  await withProject(async (root) => {
    const lifecycle = join(root, 'docs/project-lifecycle');
    await symlink(
      join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md'),
      join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-link-en.md'),
    );
    const result = await buildArchiveCatalog({
      root,
      delivery_locators: ['archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-link-en.md'],
    });
    assert.equal(result.ok, false);
    assert.equal(await lstat(join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-link-en.md')).then((entry) => entry.isSymbolicLink()), true);
  });
});

test('rejects duplicate artifact IDs and foreign project identity without source-text diagnostics', async () => {
  await withProject(async (root) => {
    const lifecycle = join(root, 'docs/project-lifecycle');
    await cp(
      join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md'),
      join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-copy-en.md'),
    );
    const duplicate = await buildArchiveCatalog({
      root,
      delivery_locators: [
        'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-copy-en.md',
        'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
      ],
    });
    assert.equal(duplicate.ok, false);
    assert.equal(JSON.stringify(duplicate).includes('BODY-SECRET'), false);

    const foreignPath = join(lifecycle, 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md');
    const source = await readFile(foreignPath, 'utf8');
    await writeFile(foreignPath, source.replace('project_id_at_creation: sample-project', 'project_id_at_creation: foreign-project'));
    const foreign = await buildArchiveCatalog({
      root,
      delivery_locators: ['archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md'],
    });
    assert.equal(foreign.ok, false);
    assert.equal(JSON.stringify(foreign).includes('ARCHIVE-WIKI-BODY-SECRET'), false);
  });
});

test('rejects stale catalog hashes with a stable redacted error', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const path = join(root, 'docs/project-lifecycle/archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\nchanged SECRET-ONLY-IN-SOURCE\n`);
    const reads = [];
    const result = await resolveArchiveArtifacts(
      archiveRequest(root, catalog),
      { onRead: (entry) => reads.push(entry) },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [{
      code: 'ARCHIVE_HASH_MISMATCH',
      path: '/artifact_ids/0',
      message: 'Archive content no longer matches the approved catalog hash.',
    }]);
    assert.equal(JSON.stringify(result).includes('SECRET-ONLY-IN-SOURCE'), false);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].outcome, 'hash-mismatch');
  });
});

test('requires a new explicitly confirmed receipt before expanding artifacts or domain scope', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const first = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    assert.equal(first.ok, true);
    const expandedReceipt = receipt({
      artifact_ids: ['prd-search-v1', 'prd-wiki-layout-v1'],
      scope: { domain_ids: ['search-workspace', 'wiki-workspace'] },
      returned_artifacts: first.value.reuse_record.returned_artifacts,
    });
    const reads = [];
    const rejected = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: expandedReceipt,
        previous_record: first.value.reuse_record,
      }),
      { onRead: (entry) => reads.push(entry) },
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, 'ARCHIVE_CONFIRMATION_REQUIRED');
    assert.deepEqual(reads, []);

    const accepted = await resolveArchiveArtifacts(archiveRequest(root, catalog, {
      receipt: {
        ...expandedReceipt,
        receipt_id: 'archive-receipt-wiki-and-search',
        approval_ref: 'user-confirmation-17',
      },
      previous_record: first.value.reuse_record,
    }));
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.value.artifacts.map(({ artifact_id: id }) => id), [
      'prd-search-v1',
      'prd-wiki-layout-v1',
    ]);
    assert.equal(accepted.value.artifacts[1].reused, true);
    assert.equal(accepted.value.reuse_record.receipt_revision, 2);
  });
});

test('requires explicit confirmation for an initial cross-domain request', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const crossDomain = receipt({
      receipt_id: 'archive-receipt-two-domains',
      artifact_ids: ['prd-search-v1', 'prd-wiki-layout-v1'],
      scope: { domain_ids: ['search-workspace', 'wiki-workspace'] },
    });
    const rejected = await resolveArchiveArtifacts(archiveRequest(root, catalog, { receipt: crossDomain }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, 'ARCHIVE_CONFIRMATION_REQUIRED');

    const accepted = await resolveArchiveArtifacts(archiveRequest(root, catalog, {
      receipt: { ...crossDomain, approval_ref: 'user-confirmation-18' },
    }));
    assert.equal(accepted.ok, true);
  });
});

test('reuses an unchanged task-local hash record without rereading the body', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const first = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    const repeatedReceipt = receipt({ returned_artifacts: first.value.reuse_record.returned_artifacts });
    const reads = [];
    const repeated = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: repeatedReceipt,
        previous_record: first.value.reuse_record,
      }),
      { onRead: (entry) => reads.push(entry) },
    );

    assert.equal(repeated.ok, true);
    assert.deepEqual(reads, []);
    assert.deepEqual(repeated.value.read_log, []);
    assert.deepEqual(repeated.value.artifacts, [{
      artifact_id: 'prd-wiki-layout-v1',
      locator: 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
      content_hash: artifactById(catalog, 'prd-wiki-layout-v1').content_hash,
      content: null,
      reused: true,
    }]);
    assert.equal(repeated.value.reuse_record.receipt_revision, 2);
  });
});

test('requires a new confirmed receipt when a rebuilt catalog reports changed content', async () => {
  await withProject(async (root) => {
    const initialCatalog = (await catalogFor(root)).value;
    const first = await resolveArchiveArtifacts(archiveRequest(root, initialCatalog));
    const path = join(root, 'docs/project-lifecycle/archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\nAccepted density changed.\n`);
    const changedCatalog = (await catalogFor(root)).value;
    const returned = first.value.reuse_record.returned_artifacts;

    const rejected = await resolveArchiveArtifacts(archiveRequest(root, changedCatalog, {
      receipt: receipt({ returned_artifacts: returned }),
      previous_record: first.value.reuse_record,
    }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, 'ARCHIVE_CONFIRMATION_REQUIRED');

    const accepted = await resolveArchiveArtifacts(archiveRequest(root, changedCatalog, {
      receipt: receipt({
        receipt_id: 'archive-receipt-wiki-content-change',
        approval_ref: 'user-confirmation-19',
        returned_artifacts: returned,
      }),
      previous_record: first.value.reuse_record,
    }));
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.artifacts[0].reused, false);
    assert.match(accepted.value.artifacts[0].content, /Accepted density changed/u);
  });
});

test('recommends durable evidence only after the caller declares material decision impact', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const ordinary = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    assert.equal(ordinary.value.durable_evidence_recommendation, null);

    const material = await resolveArchiveArtifacts(archiveRequest(root, catalog, {
      material_decision_changed: true,
    }));
    assert.deepEqual(material.value.durable_evidence_recommendation, {
      disposition: 'candidate-evidence-only',
      artifact_refs: [{
        artifact_id: 'prd-wiki-layout-v1',
        content_hash: artifactById(catalog, 'prd-wiki-layout-v1').content_hash,
        locator: 'archive/delivery/prds/prd-wiki-layout-v1/prd-wiki-layout-v1-en.md',
      }],
      auto_promote_current: false,
    });
  });
});

test('rejects forged reuse state and exact receipt-return mismatches before reading', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const first = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    const forged = {
      ...first.value.reuse_record,
      task_ref: 'different-task',
      receipt_revision: 0,
    };
    const reads = [];
    const result = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: receipt({ returned_artifacts: [{
          artifact_id: 'prd-wiki-layout-v1',
          content_hash: `sha256:${'0'.repeat(64)}`,
        }] }),
        previous_record: forged,
      }),
      { onRead: (entry) => reads.push(entry) },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(reads, []);
  });
});

test('rejects unsafe task references and unknown reuse scope fields before reading', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const reads = [];
    const unsafeTask = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: receipt({ task_ref: 'https://user:secret@example.com/task' }),
      }),
      { onRead: (entry) => reads.push(entry) },
    );
    assert.equal(unsafeTask.ok, false);

    const first = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    const unknownScope = {
      ...first.value.reuse_record,
      scope: { ...first.value.reuse_record.scope, recursive: true },
    };
    const invalidReuse = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: receipt({ returned_artifacts: first.value.reuse_record.returned_artifacts }),
        previous_record: unknownScope,
      }),
      { onRead: (entry) => reads.push(entry) },
    );
    assert.equal(invalidReuse.ok, false);
    assert.deepEqual(reads, []);
  });
});

test('matches task-local returned hashes semantically across object key order', async () => {
  await withProject(async (root) => {
    const catalog = (await catalogFor(root)).value;
    const first = await resolveArchiveArtifacts(archiveRequest(root, catalog));
    const reordered = first.value.reuse_record.returned_artifacts.map(({ artifact_id: artifactId, content_hash: contentHash }) => ({
      content_hash: contentHash,
      artifact_id: artifactId,
    }));
    const reads = [];
    const repeated = await resolveArchiveArtifacts(
      archiveRequest(root, catalog, {
        receipt: receipt({ returned_artifacts: reordered }),
        previous_record: first.value.reuse_record,
      }),
      { onRead: (entry) => reads.push(entry) },
    );
    assert.equal(repeated.ok, true);
    assert.deepEqual(reads, []);
    assert.equal(repeated.value.artifacts[0].reused, true);
  });
});
