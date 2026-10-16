import { buildIdentitySchema, sourceHashRecordSchema, type ReviewedCatalogue, type TestingBuildReadiness } from './model';
import { catalogueDigest, sourceContentDigest, testingSourcePaths } from './hash';
/** Pure seam permits a bundled reviewed catalogue to check exact compiled identity without runtime IO. */
export function testingBuildReadiness(raw: unknown, bundled: { catalogueHash: string; contentHash: string }): TestingBuildReadiness {
  const parsed = buildIdentitySchema.safeParse(raw);
  if (!parsed.success) return { status: 'review_required', reason: 'missing_identity' };
  if (parsed.data.catalogueHash !== bundled.catalogueHash) return { status: 'review_required', reason: 'catalogue_mismatch' };
  if (parsed.data.contentHash !== bundled.contentHash) return { status: 'review_required', reason: 'content_mismatch' };
  return { status: 'verified_build_identity', identity: parsed.data, activeServiceVerified: false };
}
/** Next substitutes these exact nonsecret expressions at build time. Do not destructure or index env. */
export function compiledTestingBuildReadiness(catalogue: ReviewedCatalogue): TestingBuildReadiness {
  const encoded = process.env.AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD;
  if (typeof encoded !== 'string' || encoded.length > 8 * 1024 * 1024) return { status: 'review_required', reason: 'missing_identity' };
  let record: ReturnType<typeof sourceHashRecordSchema.parse>;
  try { record = sourceHashRecordSchema.parse(JSON.parse(encoded)); }
  catch { return { status: 'review_required', reason: 'missing_identity' }; }
  const required = testingSourcePaths(catalogue), supplied = record.map(r => r.path).sort();
  if (required.length !== supplied.length || required.some((p, i) => p !== supplied[i])) return { status: 'review_required', reason: 'content_mismatch' };
  return testingBuildReadiness({
    sourceRef: process.env.AIHR_SYSTEM_TESTING_SOURCE_REF,
    buildRecordId: process.env.AIHR_SYSTEM_TESTING_BUILD_RECORD_ID,
    catalogueHash: process.env.AIHR_SYSTEM_TESTING_CATALOGUE_HASH,
    contentHash: process.env.AIHR_SYSTEM_TESTING_CONTENT_HASH,
  }, { catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest(record) });
}
