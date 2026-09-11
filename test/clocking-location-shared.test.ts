/**
 * f9afd1ce — clocking locations are a SHARED, TENANT-LEVEL master (migration 0459; ADR-0070 amended
 * 2026-09-11). SOURCE-SHAPE guard: the decisions that are easy to undo one file at a time without any
 * behavioural test noticing.
 *
 *   • The migration is journalled (a .sql without an entry never runs) with a `when` above 0458's.
 *   • Write authority is app.is_group_admin() on INSERT, UPDATE and DELETE — and the migration no longer
 *     names the per-company admin predicate anywhere (a stray reference would mean the old rule survived
 *     in a policy or a comment that a later reader would copy).
 *   • The schema has no company_id on clocking_location and the name index is per tenant.
 *   • EVERY writer in the service calls assertGroupAdmin — the one guard that answers in words; RLS
 *     UPDATE/DELETE policies filter silently, so a writer that forgot the call would "succeed" and change
 *     nothing for a company admin.
 *   • listClockingLocations has no company parameter, and the personnel page calls it without one — that
 *     call was the single line that made assignment per-company in practice.
 *   • The screen renders the forms for group admins only and posts no companyId.
 *
 * Behaviour (the 42501, the service refusal, cross-company assignment landing, the optional link) lives in
 * test/clocking-geofence.test.ts. This file pins the SHAPE those behaviours depend on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MIGRATION_TAG = '0459_clocking_location_shared';
const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
  entries: { idx: number; when: number; tag: string }[];
};
const migration = read(`db/migrations/${MIGRATION_TAG}.sql`);
const service = read('core/clocking-location.ts');

/** The body of one exported function: from its `export [async] function NAME(` to the next top-level export. */
function exportedFunctionBody(src: string, name: string): string {
  const m = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
  if (!m) throw new Error(`${name} is not an exported function in core/clocking-location.ts`);
  const start = m.index;
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

/** The text of one CREATE POLICY … FOR <verb> statement in the migration. */
function policyFor(verb: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'): string {
  const m = new RegExp(`CREATE POLICY "clocking_location_${verb.toLowerCase()}" ON "clocking_location" FOR ${verb}[\\s\\S]*?;`).exec(migration);
  if (!m) throw new Error(`no CREATE POLICY … FOR ${verb} in ${MIGRATION_TAG}.sql`);
  return m[0];
}

describe('f9afd1ce — migration 0459 is journalled and says what it must', () => {
  it('the journal carries idx 459 with the matching tag, and its when is above 0458', () => {
    const e459 = journal.entries.find((e) => e.idx === 459);
    const e458 = journal.entries.find((e) => e.idx === 458);
    expect(e459?.tag).toBe(MIGRATION_TAG);
    expect(e458).toBeTruthy();
    expect(e459!.when).toBeGreaterThan(e458!.when);
  });

  it('INSERT, UPDATE and DELETE require app.is_group_admin(); SELECT stays tenant-wide', () => {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      expect(policyFor(verb), `${verb} policy must require app.is_group_admin()`).toContain('app.is_group_admin()');
    }
    // UPDATE needs it on BOTH clauses: USING (which rows may be touched) and WITH CHECK (what they may become).
    const update = policyFor('UPDATE');
    expect(update).toMatch(/USING \([^)]*app\.is_group_admin\(\)\)/);
    expect(update).toMatch(/WITH CHECK \([^)]*app\.is_group_admin\(\)\)/);
    const select = policyFor('SELECT');
    expect(select).not.toContain('is_group_admin');
    expect(select).toContain('tenant_id = app.current_tenant_id()');
  });

  it('the per-company admin predicate appears NOWHERE in the migration (policy or prose)', () => {
    expect(migration).not.toContain('is_admin_for');
  });

  it('drops the FK, both company indexes and the column, recreates the name index per tenant, drops the FOR ALL policy', () => {
    expect(migration).toContain('DROP CONSTRAINT "clocking_location_company_id_company_id_fk"');
    expect(migration).toContain('DROP INDEX "clocking_location_company_idx"');
    expect(migration).toContain('DROP INDEX "clocking_location_name_uq"');
    expect(migration).toContain('ALTER TABLE "clocking_location" DROP COLUMN "company_id"');
    expect(migration).toContain('CREATE UNIQUE INDEX "clocking_location_name_uq" ON "clocking_location" USING btree ("tenant_id","name")');
    expect(migration).toContain('DROP POLICY "clocking_location_rls" ON "clocking_location"');
    // No data step, said out loud, and the row count it found is REPORTED rather than assumed.
    expect(migration).toContain('RAISE NOTICE');
    expect(migration).toMatch(/SELECT count\(\*\)[\s\S]*FROM clocking_location/);
  });
});

describe('f9afd1ce — db/schema.ts: clocking_location has no owner company', () => {
  const schema = read('db/schema.ts');
  const start = schema.indexOf("export const clockingLocation = pgTable(\n  'clocking_location',");
  const end = schema.indexOf('\nexport const ', start + 1);
  const block = schema.slice(start, end);

  it('the table block exists and carries no companyId column and no company index', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toContain('companyId');
    expect(block).not.toContain("'company_id'");
    expect(block).not.toContain('clocking_location_company_idx');
  });

  it('the name index is (tenantId, name)', () => {
    expect(block).toContain("uniqueIndex('clocking_location_name_uq').on(t.tenantId, t.name)");
  });
});

describe('f9afd1ce — core/clocking-location.ts: every writer asserts group-admin authority', () => {
  const WRITERS = [
    'createClockingLocation',
    'updateClockingLocation',
    'archiveClockingLocation',
    'restoreClockingLocation',
    'deleteClockingLocation',
  ] as const;

  it.each(WRITERS)('%s calls assertGroupAdmin(ctx)', (name) => {
    expect(exportedFunctionBody(service, name), `${name} must call assertGroupAdmin(ctx) before writing`).toContain(
      'assertGroupAdmin(ctx)',
    );
  });

  it('assertGroupAdmin is the TS twin of app.is_group_admin(): isGroupAdmin over withEffectiveGrants', () => {
    // withEffectiveGrants is what makes the service agree with withTenant's treatment of a roles-only
    // context; without it the service would refuse a context the database accepts.
    expect(service).toMatch(/function assertGroupAdmin\(ctx: SessionContext\)[\s\S]*?isGroupAdmin\(withEffectiveGrants\(ctx\)\)/);
  });

  it('listClockingLocations takes no company parameter, and the cross-company assignment guard is gone', () => {
    expect(service).toMatch(/export function listClockingLocations\(\s*ctx: SessionContext,\s*opts: \{ includeArchived\?: boolean \} = \{\},?\s*\)/);
    expect(service).not.toContain('CrossCompanyClockingLocationError');
    expect(service).not.toContain('clockingLocation.companyId');
    // The row type carries the "Used by" list the screen renders as chips.
    expect(service).toContain('usedByCompanies: string[];');
  });
});

describe('f9afd1ce — the two screens', () => {
  it('the personnel page offers EVERY shared site: listClockingLocations(s), not [emp.companyId]', () => {
    const page = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(page).toContain('await listClockingLocations(s) : []');
    expect(page).not.toContain('listClockingLocations(s, [emp.companyId])');
    // The empty state must not claim clock-in is unavailable when shared sites exist: the sentence now
    // reports the linked count and says every shared site is offered.
    expect(page).toContain("tc('linkedPoints', { count: resolvedLocationPointCount })");
    expect(page).not.toContain("tc('noSites')");
  });

  it('the locations page renders ONE tenant-level block, gates the forms on isGroupAdmin, and posts no companyId for a site', () => {
    const page = read('app/admin/locations/page.tsx');
    expect(page).toContain('const groupAdmin = isGroupAdmin(s);');
    expect(page).toContain('await listClockingLocations(s, { includeArchived: true })');
    expect(page).toContain('{groupAdmin && (\n          <form\n            action={createClockingLocationAction}');
    expect(page).toContain("t('sharedManagedByGroupAdmin')");
    // The clocking create form used to carry <input type="hidden" name="companyId" …> — only the
    // per-company `location` form may still post one.
    const clockingForm = page.slice(page.indexOf('action={createClockingLocationAction}'), page.indexOf("t('add')", page.indexOf('action={createClockingLocationAction}')));
    expect(clockingForm).not.toContain('name="companyId"');
    expect(page).toContain("t('usedBy')");
  });

  it('the create action posts no companyId', () => {
    const actions = read('app/admin/actions.ts');
    const fn = actions.slice(
      actions.indexOf('export async function createClockingLocationAction'),
      actions.indexOf('export async function updateClockingLocationAction'),
    );
    expect(fn).not.toContain('companyId');
  });

  it('the six locales carry every new key, and the retired ones are gone', () => {
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        admin: { locations: Record<string, string> };
        people: { detail: { clocking: Record<string, string> } };
      };
      for (const k of [
        'clockingSharedTitle',
        'sharedManagedByGroupAdmin',
        'usedBy',
        'coordinates',
        'radiusMetres',
        'clockingLocationLinkOptional',
        'clockingLocationNone',
        'linkedOutOfScopeGroupTitle',
        'noSharedSites',
      ]) {
        expect(m.admin.locations[k], `${loc} admin.locations.${k}`).toBeTruthy();
      }
      expect(m.admin.locations.noLocationsForCompany, `${loc} retired key`).toBeUndefined();
      expect(m.people.detail.clocking.noSharedSites, `${loc} people.detail.clocking.noSharedSites`).toBeTruthy();
      expect(m.people.detail.clocking.linkedPoints, `${loc} people.detail.clocking.linkedPoints`).toContain('{count, plural,');
      expect(m.people.detail.clocking.noSites, `${loc} retired key`).toBeUndefined();
    }
  });
});

describe('f9afd1ce — ADR-0070 records the amendment rather than being rewritten', () => {
  const adr = read('docs/adr/0070-clocking-locations-geofencing.md');
  it('keeps the original §2 text and appends the amendment', () => {
    expect(adr).toContain('### 2. RLS: tenant-catalog read, company-admin write (mirrors 0065 `pay_component`)');
    expect(adr).toContain('Amended 2026-09-11 (f9afd1ce)');
  });
});
