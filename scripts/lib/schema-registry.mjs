import Ajv2020 from 'ajv/dist/2020.js';

import projectExtensionsSchema from '../schemas/project-extensions.schema.json' with { type: 'json' };
import projectMapSchema from '../schemas/project-map.schema.json' with { type: 'json' };
import projectPointerSchema from '../schemas/project-pointer.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ allErrors: true, strict: true });

const schemaValidators = new Map(
  [projectMapSchema, projectPointerSchema, projectExtensionsSchema]
    .map((schema) => [schema.$id, ajv.compile(schema)]),
);

export const getSchemaValidator = (kind) => schemaValidators.get(kind);
