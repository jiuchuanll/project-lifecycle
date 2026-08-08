import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import archiveAccessReceiptSchema from '../schemas/archive-access-receipt.schema.json' with { type: 'json' };
import capabilityFrontmatterSchema from '../schemas/capability-frontmatter.schema.json' with { type: 'json' };
import contextReceiptSchema from '../schemas/context-receipt.schema.json' with { type: 'json' };
import deliveryFrontmatterSchema from '../schemas/delivery-frontmatter.schema.json' with { type: 'json' };
import knowledgeDiffSchema from '../schemas/knowledge-diff.schema.json' with { type: 'json' };
import obligationInstanceSchema from '../schemas/obligation-instance.schema.json' with { type: 'json' };
import pendingChangesSchema from '../schemas/pending-changes.schema.json' with { type: 'json' };
import projectExtensionsSchema from '../schemas/project-extensions.schema.json' with { type: 'json' };
import projectMapSchema from '../schemas/project-map.schema.json' with { type: 'json' };
import projectPointerSchema from '../schemas/project-pointer.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaValidators = new Map(
  [
    projectMapSchema,
    projectPointerSchema,
    projectExtensionsSchema,
    capabilityFrontmatterSchema,
    pendingChangesSchema,
    contextReceiptSchema,
    knowledgeDiffSchema,
    archiveAccessReceiptSchema,
    obligationInstanceSchema,
    deliveryFrontmatterSchema,
  ]
    .map((schema) => [schema.$id, ajv.compile(schema)]),
);

export const getSchemaValidator = (kind) => schemaValidators.get(kind);
