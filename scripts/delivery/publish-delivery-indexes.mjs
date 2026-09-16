import { resolve } from 'node:path';

import { createError } from '../lib/errors.mjs';
import { fail, ok } from '../lib/result.mjs';
import { applyLayoutTransaction, inspectLifecycleTree } from '../knowledge/layout-transaction.mjs';
import { collectDeliveryInventory } from './delivery-inventory.mjs';
import { generateDeliveryIndexes } from './delivery-indexes.mjs';

export const publishDeliveryIndexes = async ({ root } = {}) => {
  const [inventory, tree] = await Promise.all([
    collectDeliveryInventory({ lifecycleRoot: resolve(root, 'docs/project-lifecycle') }),
    inspectLifecycleTree({ repositoryRoot: root }),
  ]);
  if (!inventory.ok || !tree.ok) return !inventory.ok ? inventory : tree;
  const indexes = await generateDeliveryIndexes({ inventory: inventory.value });
  if (!indexes.ok) return indexes;
  const published = await applyLayoutTransaction({
    repositoryRoot: root,
    expectedFingerprint: tree.value.fingerprint,
    candidateFiles: indexes.value.files.map(({ locator, content }) => ({
      repository_id: null,
      locator,
      content,
      validate: async (candidate) => candidate === content ? ok(candidate) : fail([
        createError('DELIVERY_INDEX_INVALID', `/${locator}`, 'Generated index changed.'),
      ]),
    })),
    candidateDirectories: [],
    deleteLocators: [],
    validateCandidate: ({ lifecycleRoot }) => collectDeliveryInventory({ lifecycleRoot }),
  });
  return published.ok ? ok({
    layout_version: 2,
    locators: indexes.value.files.map(({ locator }) => locator),
    changed: published.value.changed,
  }) : published;
};
