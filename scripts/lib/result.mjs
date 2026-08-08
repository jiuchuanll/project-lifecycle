export const ok = (value = null) => ({ ok: true, value, errors: [] });
export const fail = (errors) => ({ ok: false, value: null, errors });
