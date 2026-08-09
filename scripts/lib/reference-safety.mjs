import { isAbsolute, posix } from 'node:path';

const credentialBearingUrl = /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/iu;

export const isSafeReference = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 500
  && !/[\p{Cc}\p{Cf}\p{Z}`<>\\]/u.test(value)
  && !value.includes('--')
  && !credentialBearingUrl.test(value);

export const isSafeLocator = (value) => typeof value === 'string'
  && isSafeReference(value)
  && !isAbsolute(value)
  && !/^[A-Za-z]:[\\/]/u.test(value)
  && !value.includes('://')
  && !/[#()]/u.test(value)
  && !value.split('/').includes('..')
  && posix.normalize(value) === value;
