/**
 * The digest a capacity failure carries to the browser. Pure, so a client error boundary can read it
 * without pulling database code into a client bundle.
 */
export const DATABASE_CAPACITY_DIGEST = 'AIHR_DATABASE_CAPACITY';

/** Seconds a caller should wait before retrying after a capacity failure. */
export const DATABASE_RETRY_AFTER_SECONDS = 5;

export const isDatabaseCapacityDigest = (digest: string | undefined): boolean => digest === DATABASE_CAPACITY_DIGEST;
