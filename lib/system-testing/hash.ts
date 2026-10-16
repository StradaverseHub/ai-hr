/** Server/tool leaf: stable JSON and source-content hashes, never tenant data or runtime git. */
import { createHash } from 'node:crypto';
import { catalogueSchema, testingSourcePath, type ReviewedCatalogue } from './model';
export function stableTestingJson(raw: unknown): string {
  const seen = new WeakSet<object>();
  function visit(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || seen.has(value)) throw new Error('Testing evidence must be bounded JSON without circular references.');
    seen.add(value);
    if (Array.isArray(value)) { const result = value.map(visit); seen.delete(value); return result; }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Testing evidence must use plain objects.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(d => 'get' in d || 'set' in d)) throw new Error('Executable evidence is not supported.');
    const result = Object.fromEntries(Object.keys(descriptors).sort().map(key => [key, visit(descriptors[key].value)]));
    seen.delete(value);
    return result;
  }
  return JSON.stringify(visit(raw));
}
export function testingDigest(raw: unknown): string { return createHash('sha256').update(stableTestingJson(raw)).digest('hex'); }
export function catalogueDigest(catalogue: ReviewedCatalogue): string { return testingDigest(catalogueSchema.parse(catalogue)); }
export function testingSourcePaths(catalogue: ReviewedCatalogue): string[] {
  return [...new Set(catalogueSchema.parse(catalogue).entries.flatMap(e => e.sources))].sort();
}
export function sourceContentDigest(contents: ReadonlyArray<{ path: string; sha256: string }>): string {
  const unique = new Set<string>();
  for (const entry of contents) {
    testingSourcePath.parse(entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || unique.has(entry.path)) throw new Error('Invalid source evidence.');
    unique.add(entry.path);
  }
  return testingDigest([...contents].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
