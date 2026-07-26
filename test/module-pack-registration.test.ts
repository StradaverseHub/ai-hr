/**
 * ADR-0077 slice 1 — the client-bundle ratchet for `packs/register-all.ts`.
 *
 * That file's header claims this test exists and pins its safety property. It did not exist, so the
 * property was enforced by nothing: `components/sidebar.tsx` is a CLIENT component, and it now reaches
 * the five packs through this one import instead of five explicit ones. A single
 * `import '@/packs/payroll/service'` added to register-all.ts would drag server-only code (db/client,
 * the payroll kernel, node crypto) into the client bundle, and the failure would be a build error far
 * from its cause — or worse, a silent bundle-size regression.
 *
 * Asserted by READING THE SOURCE rather than by importing it, deliberately: importing the file only
 * proves it evaluates under vitest's node resolver, which is exactly the environment where a
 * server-only import is fine. The property is about what the text may contain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../packs/catalog';
import '../packs/register-all';
import { listPacks } from '../packs/registry';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');

/** Every `import …` statement in the file, comments and blank lines excluded. */
function importLines(): string[] {
  return SOURCE.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('import '));
}

describe('packs/register-all.ts — the client-safety ratchet', () => {
  it('imports pack INDEXES only, never a service facade', () => {
    const lines = importLines();
    expect(lines.length, 'register-all.ts has no imports — it registers nothing').toBeGreaterThan(0);
    for (const line of lines) {
      // A pack index is `@/packs/<name>` and nothing deeper. `@/packs/payroll/service` — or any other
      // second path segment — is what this test exists to refuse.
      expect(line, `not a bare pack-index side-effect import: ${line}`).toMatch(/^import '@\/packs\/[a-z-]+';$/);
      expect(line, `a service facade is server-only and must never be imported here: ${line}`).not.toContain('/service');
    }
  });

  it('registers every pack-backed module in the catalog', () => {
    // The other half of the file's job. The drift test already pins catalog↔registry correspondence,
    // but only once something has registered the packs — which, on the server, is this file alone.
    const registered = new Set(listPacks('module').map((p) => p.id));
    for (const m of MODULE_CATALOG.filter((x) => x.packBacked)) {
      expect(registered.has(m.code), `pack-backed module '${m.code}' is not registered by register-all.ts`).toBe(true);
    }
  });

  it('is what the client sidebar depends on for registration', () => {
    // If the sidebar ever goes back to importing packs directly, this file stops being the choke point
    // the ratchet above guards, and the guard would keep passing while protecting nothing.
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    expect(sidebar).toContain(`import '@/packs/register-all'`);
  });
});
