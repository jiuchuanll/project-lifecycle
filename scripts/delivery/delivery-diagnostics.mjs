import { getSchemaValidator } from '../lib/schema-registry.mjs';
import { validateJson } from '../lib/validate-json.mjs';
import { fail, ok } from '../lib/result.mjs';

export const FIELD_DIAGNOSTICS = Object.freeze({
  required: { message: 'A required Frontmatter field is missing.', action: 'Add the indicated field using grounded values from the delivery template.' },
  additionalProperties: { message: 'This Frontmatter field is not supported.', action: 'Move descriptive content into the Markdown body; keep only template machine fields.' },
  type: { message: 'This Frontmatter field has the wrong type.', action: 'Use the field type declared by the delivery template and schema.' },
  enum: { message: 'This Frontmatter field is outside the allowed values.', action: 'Use an allowed schema value consistent with the intended delivery state.' },
  const: { message: 'This Frontmatter field does not match its required value.', action: 'Use the value required by the delivery schema.' },
  pattern: { message: 'This Frontmatter identifier has an invalid format.', action: 'Use the canonical lowercase identifier format and required kind prefix.' },
  semantic: { message: 'This Frontmatter field violates a delivery relationship or schema constraint.', action: 'Reconcile the indicated field with the template, ownership and relationship rules.' },
});
const pointerToken = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const diagnostic = (code, path, reason, expected) => ({
  code, path, reason, ...FIELD_DIAGNOSTICS[reason],
  ...(expected ? { expected } : {}),
});

// Only rule names, paths and schema-owned type names are exposed, never input values.
export const validateDeliveryFields = (value, { code = 'DELIVERY_FRONTMATTER_INVALID', path = '/frontmatter' } = {}) => {
  const validator = getSchemaValidator('delivery-frontmatter');
  if (!validator(value)) {
    const errors = validator.errors.filter(({ keyword }) => keyword !== 'if').map((error) => {
      const suffix = error.keyword === 'required'
        ? `${error.instancePath}/${pointerToken(error.params.missingProperty)}`
        : error.keyword === 'additionalProperties'
          ? `${error.instancePath}/${pointerToken(error.params.additionalProperty)}`
          : error.instancePath;
      const reason = Object.hasOwn(FIELD_DIAGNOSTICS, error.keyword) ? error.keyword : 'semantic';
      return diagnostic(code, `${path}${suffix}`, reason, error.keyword === 'type' ? error.params.type : undefined);
    });
    return fail(errors);
  }
  const result = validateJson('delivery-frontmatter', value);
  return result.ok ? ok(value) : fail(result.errors.map((error) => diagnostic(
    code, `${path}${error.path === '/' ? '' : error.path}`, 'semantic',
  )));
};
