/** The People directory's address contract (ADR 0181 Phase 4, list-only filters): the page's search parameters,
 * which the list endpoint accepts as its JSON body. Dependency-free, shared by the page, the endpoint and the view. */
export const DIRECTORY_PARAMS = ['q', 'company', 'dept', 'status', 'type', 'page', 'size', 'after', 'before', 'last', 'count'] as const;
export type DirectoryParams = Partial<Record<(typeof DIRECTORY_PARAMS)[number], string>>;
export const DIRECTORY_FILTERS = ['q', 'company', 'dept', 'status', 'type'] as const;

/** Only the directory's own string parameters survive; anything else is dropped, never interpreted. */
export function directoryParams(raw: Record<string, unknown>): DirectoryParams {
  const out: DirectoryParams = {};
  for (const key of DIRECTORY_PARAMS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length <= 200) out[key] = value;
  }
  return out;
}
