import { afterEach, describe, expect, it, vi } from 'vitest';
import { compiledTestingBuildReadiness } from '../lib/system-testing/build-identity';
import { catalogueDigest, sourceContentDigest, stableTestingJson } from '../lib/system-testing/hash';
import type { ReviewedCatalogue } from '../lib/system-testing/model';
import { systemTestingCompileEnvironment, type PreparedTestingBuild } from '../scripts/improve/system-testing-manifest';
import { readFileSync } from 'node:fs';
const catalogue: ReviewedCatalogue = { format: 1, revision: 'identity.test', entries: [] };
const prepared: PreparedTestingBuild = { format: 1, identity: { sourceRef: 'a'.repeat(40), buildRecordId: '6fa9e236-7a92-42d6-94a5-9b703ff6a16c', catalogueHash: catalogueDigest(catalogue), contentHash: sourceContentDigest([]) }, sourceHashRecord: [], activeServiceVerified: false };
afterEach(() => vi.unstubAllEnvs());
function inject() { for (const [key, value] of Object.entries(systemTestingCompileEnvironment(prepared))) vi.stubEnv(key, value); }
describe('compile-bound System Testing identity contract (not a Next artifact proof)', () => {
  it('configures exactly the five direct nonsecret substitutions with empty review-required defaults', () => {
    const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
    const block = config.slice(config.indexOf('  env: {'), config.indexOf('\n  },', config.indexOf('  env: {')));
    for (const key of Object.keys(systemTestingCompileEnvironment(prepared))) expect(block).toContain(`${key}: process.env.${key} ?? ''`);
    expect(block.match(/AIHR_SYSTEM_TESTING_[A-Z_]+:/g)).toHaveLength(5);
    expect(block).not.toContain('...process.env'); expect(block).not.toContain('DATABASE_URL');
  });
  it('accepts the exact bounded source record and never claims live service parity', () => {
    inject(); expect(compiledTestingBuildReadiness(catalogue)).toEqual({ status: 'verified_build_identity', identity: prepared.identity, activeServiceVerified: false });
    expect(Object.keys(systemTestingCompileEnvironment(prepared)).sort()).toEqual(['AIHR_SYSTEM_TESTING_BUILD_RECORD_ID','AIHR_SYSTEM_TESTING_CATALOGUE_HASH','AIHR_SYSTEM_TESTING_CONTENT_HASH','AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD','AIHR_SYSTEM_TESTING_SOURCE_REF']);
  });
  it('refuses extra paths, malformed JSON, absent source evidence and different content hash', () => {
    inject(); vi.stubEnv('AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD', stableTestingJson([{ path: 'core/read.ts', sha256: 'a'.repeat(64) }]));
    expect(compiledTestingBuildReadiness(catalogue)).toEqual({ status: 'review_required', reason: 'content_mismatch' });
    vi.stubEnv('AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD', '{'); expect(compiledTestingBuildReadiness(catalogue).status).toBe('review_required');
    vi.stubEnv('AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD', '[]'); vi.stubEnv('AIHR_SYSTEM_TESTING_CONTENT_HASH', 'b'.repeat(64));
    expect(compiledTestingBuildReadiness(catalogue)).toEqual({ status: 'review_required', reason: 'content_mismatch' });
    vi.stubEnv('AIHR_SYSTEM_TESTING_SOURCE_HASH_RECORD', undefined); expect(compiledTestingBuildReadiness(catalogue).status).toBe('review_required');
  });
});
