/** WP11 (R5; ADR-0151 §4.6d): the EXPLICIT set of tracked files whose bytes bind a governed Assistant
 * candidate, evaluation, promotion and job receipt (lib/ai/module-agent-source-manifest.ts).
 *
 * Before WP11 the manifest hashed every tracked ts/tsx/mjs/sql/json file, so ANY deploy (a payroll screen,
 * a translation, a seed) changed MODULE_AGENT_SOURCE_DIGEST and retired every promotion. The digest now
 * covers only the AI behaviour surface below. A change outside it does not invalidate learning; a change
 * inside it does. Canonical HR services that the readers call (packs/*, core/read.ts, …) are deliberately
 * outside: promoted behaviour only interprets facts those owners return afresh on every run, and their
 * own tests own their correctness.
 *
 * In scope (tracked, extension ts|tsx|mjs|sql|json, never the generated manifest itself):
 *  - lib/ai/**                      model-facing contracts, holdouts, candidates, specialists, routing
 *  - lib/assistant-actions/**       closed action contracts the Assistant proposes and prepares
 *  - core/assistant*.ts, core/assistant-actions/**   Assistant tools, read session, action stores
 *  - core/module-agent*.ts, core/module-specialist*.ts, core/module-native*.ts   learning-loop owners
 *  - core/ai-*.ts, core/agent-*.ts  AI governance, provider, spend, principal and agent ledgers
 *  - packs/catalog.ts               the module catalogue the module agents bind to
 *  - db/migrations/NNNN_*.sql whose name has an `ai`, `agent`, `assistant` or `specialist` word
 *  - scripts/ai-agent-source-manifest.mjs and this file
 * Pure: no filesystem, git or clock access, so tests can prove the boundary directly. */
import { createHash } from 'node:crypto';

export const AI_SOURCE_MANIFEST_OUTPUT = 'lib/ai/module-agent-source-manifest.ts';
const AI_MIGRATION_WORDS = new Set(['ai', 'agent', 'assistant', 'specialist']);
const PREFIXES = ['lib/ai/', 'lib/assistant-actions/', 'core/assistant-actions/'];
const CORE_FILE = /^core\/(?:assistant|module-agent|module-specialist|module-native|ai-|agent-)[^/]*$/;
const FILES = new Set(['core/dependent-review.ts', 'packs/catalog.ts', 'scripts/ai-agent-source-manifest.mjs', 'scripts/ai-agent-source-scope.mjs']);

export function isAiSourceFile(name) {
  if (typeof name !== 'string' || name === AI_SOURCE_MANIFEST_OUTPUT || name.startsWith('.') || !/\.(ts|tsx|mjs|sql|json)$/.test(name)) return false;
  if (FILES.has(name) || PREFIXES.some(prefix => name.startsWith(prefix)) || CORE_FILE.test(name)) return true;
  const migration = /^db\/migrations\/\d{4}_([a-z0-9_]+)\.sql$/.exec(name);
  return Boolean(migration && migration[1].split('_').some(word => AI_MIGRATION_WORDS.has(word)));
}
/** Sorted, de-duplicated in-scope names. */
export function aiSourceFiles(names) {
  return [...new Set(names)].filter(isAiSourceFile).sort();
}
/** Digest over [name, sha256(bytes)] pairs, exactly as the pre-WP11 manifest combined them. */
export function aiSourceDigest(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
