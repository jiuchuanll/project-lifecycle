import { resolve } from 'node:path';

import { inspectLifecycleTree } from '../knowledge/layout-transaction.mjs';
import { ok } from '../lib/result.mjs';
import { collectDeliveryInventory } from './delivery-inventory.mjs';
import { materializeAsset } from './materialize-asset.mjs';
import { publishDeliveryIndexes } from './publish-delivery-indexes.mjs';

const blocked = (result, context) => ({ ...result, context: { ...result.context, ...context } });

// Preparation reuses the materializer's complete validation but never reaches its writer.
export const previewDeliveryAsset = async (input) => {
  const prepared = await materializeAsset(input, { preview: true, allowExactReplay: true });
  if (!prepared.ok) return blocked(prepared, { phase: 'request', files_changed: false, request_valid: false });
  const { documents, ...asset } = prepared.value;
  const overlays = Object.fromEntries(Object.entries(asset.locators).map(([language, locator]) => [locator, documents[language]]));
  const lifecycleRoot = resolve(input.root, 'docs/project-lifecycle');
  const [baseline, inventory] = await Promise.all([
    collectDeliveryInventory({ lifecycleRoot }),
    collectDeliveryInventory({ lifecycleRoot, overlays }),
  ]);
  if (!inventory.ok) {
    const existingErrors = new Set(baseline.errors.map(({ code, path }) => JSON.stringify([code, path])));
    inventory.errors = inventory.errors.map((error) => ({
      ...error, origin: existingErrors.has(JSON.stringify([error.code, error.path])) ? 'existing_inventory' : baseline.context?.truncated ? 'undetermined' : 'candidate',
    }));
  }
  if (!inventory.ok) return blocked(inventory, {
    phase: 'candidate_inventory', files_changed: false, request_valid: true, candidate_valid: false,
    artifact_id: asset.artifact_id, locators: asset.locators,
    action: 'Fix the listed delivery inventory blockers, then repeat preview. No files were written.',
  });
  const tree = await inspectLifecycleTree({ repositoryRoot: input.root });
  if (!tree.ok) return blocked(tree, { phase: 'index_preflight', files_changed: false, request_valid: true });
  return ok({ artifact_id: asset.artifact_id, locators: asset.locators, planned_status: asset.status, files_changed: false, indexes: 'ready', request_valid: true });
};

export const materializeDeliveryWithIndexes = async (input, operations = {}) => {
  const preview = await previewDeliveryAsset(input);
  if (!preview.ok) return preview;
  const asset = await materializeAsset(input, { allowExactReplay: true });
  if (!asset.ok) return blocked(asset, {
    phase: 'materialization',
    asset_saved: asset.errors.some(({ code }) => code === 'ASSET_ROLLBACK_FAILED') ? null : false,
    indexes: 'not_attempted',
  });
  const published = await (operations.publishDeliveryIndexes ?? publishDeliveryIndexes)({ root: input.root });
  if (!published.ok) return blocked(published, {
    phase: 'index_publication', asset_saved: true, files_changed: asset.value.status !== 'unchanged' ? true : null,
    asset_changed: asset.value.status !== 'unchanged', artifact_id: asset.value.artifact_id,
    locators: asset.value.locators, indexes: 'failed',
    action: 'The document pair is saved. Fix the reported index blocker, then repeat the identical request or run generate-delivery-indexes. Do not recreate or delete the saved pair.',
  });
  return ok({
    ...asset.value, asset_saved: true, indexes: 'updated',
    files_changed: asset.value.status !== 'unchanged' || published.value.changed.length > 0,
    index_locators: published.value.locators, index_changes: published.value.changed,
  });
};
