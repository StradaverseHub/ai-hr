/**
 * Recruitment slice 8 — the public careers page addresses. Pure and edge-safe: middleware.ts imports it.
 *
 * Like the letter verification route, these are the ONLY anonymous Recruitment paths, admitted by exact shape (no
 * prefix-wide bypass): the careers page `/careers/<address>` (GET/HEAD) and one job `/careers/<address>/jobs/<jobId>`
 * (GET/HEAD, and POST for the application form). Anything else under /careers — another segment, a trailing slash, a
 * dot segment, an encoded character, an upper-case address or job id — is not admitted and stays behind sign-in.
 * The handlers still return the same Not found for every address or job that is not public.
 */

/** 3–40 lowercase letters, digits and hyphens, not starting or ending with a hyphen (the database CHECK is the same). */
export const CAREERS_ADDRESS_SOURCE = '[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]';
const ADDRESS = new RegExp(`^${CAREERS_ADDRESS_SOURCE}$`);
const JOB_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE_PATH = new RegExp(`^/careers/(${CAREERS_ADDRESS_SOURCE})$`);
const JOB_PATH = new RegExp(`^/careers/(${CAREERS_ADDRESS_SOURCE})/jobs/(${JOB_ID})$`);
/** Slice 21b: a candidate's response link `/careers/r/<token>` (43 base64url characters). "r" can never be a careers address (3–40
 *  characters), so it shadows none. */
const RESPONSE_TOKEN = '[A-Za-z0-9_-]{43}';
const RESPONSE_PATH = new RegExp(`^/careers/r/(${RESPONSE_TOKEN})$`);
/** Slice 22: a candidate's survey link `/careers/s/<token>` (the same token shape; "s" is no careers address either). */
const SURVEY_PATH = new RegExp(`^/careers/s/(${RESPONSE_TOKEN})$`);
export const isCareersResponseToken = (value: unknown): value is string => typeof value === 'string' && new RegExp(`^${RESPONSE_TOKEN}$`).test(value);

export const isCareersAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
export const isCareersJobId = (value: unknown): value is string => typeof value === 'string' && new RegExp(`^${JOB_ID}$`).test(value);

/** True only for the exact public careers paths and the methods each one serves. */
export function isCareersRoute(path: string, method = 'GET'): boolean {
  const m = method.toUpperCase();
  if (PAGE_PATH.test(path)) return m === 'GET' || m === 'HEAD';
  if (JOB_PATH.test(path)) return m === 'GET' || m === 'HEAD' || m === 'POST';
  if (RESPONSE_PATH.test(path)) return m === 'GET' || m === 'HEAD' || m === 'POST';
  if (SURVEY_PATH.test(path)) return m === 'GET' || m === 'HEAD' || m === 'POST';
  return false;
}

/** The whole application form body is refused above this before it is read (the résumé itself is at most 10 MB). The
 *  framework's proxy body buffer (next.config.ts proxyClientMaxBodySize) is kept above it, so an allowed body is never
 *  truncated before the careers handler reads it. */
export const CAREERS_BODY_MAX_BYTES = 11 * 1024 * 1024;

export const careersPagePath = (address: string) => `/careers/${address}`;
export const careersJobPath = (address: string, jobId: string) => `/careers/${address}/jobs/${jobId}`;
