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
 *   • The screen renders the forms for group admins only and posts no companyId — since r267 (rev 2) the
 *     forms live on a page of their own (app/admin/locations/clocking/*) and the list carries none.
 *
 * Behaviour (the 42501, the service refusal, cross-company assignment landing, the optional link) lives in
 * test/clocking-geofence.test.ts. This file pins the SHAPE those behaviours depend on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAll, migrateTestDb, owner } from './harness';

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
    expect(update).toMatch(/USING \(tenant_id = app\.current_tenant_id\(\) AND app\.is_group_admin\(\)\)/);
    expect(update).toMatch(/WITH CHECK \(tenant_id = app\.current_tenant_id\(\) AND app\.is_group_admin\(\)\)/);
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

/**
 * Verifier M1 — step 6's unique index would abort the file with a bare 23505 if two companies already
 * held a same-named site. The DO block PRE-FLIGHTS that before step 1 and stops with a sentence naming the
 * sites and companies. Pinned two ways: the shape (the query and the RAISE are in the file, before the
 * first DDL) and the behaviour (the migration's OWN DO block text, run against the pre-0459 table shape
 * with a real collision, raises that sentence — and does not raise without one).
 */
describe('f9afd1ce — 0459 pre-flights a same-name collision and stops with a sentence', () => {
  /** The DO block exactly as the file carries it: from `DO $$` to the first `END $$;`. */
  const doBlock = (() => {
    const start = migration.indexOf('DO $$');
    const end = migration.indexOf('END $$;', start);
    if (start === -1 || end === -1) throw new Error('0459 has no DO block');
    return migration.slice(start, end + 'END $$;'.length);
  })();

  it('the pre-flight is in the DO block, runs before the first DDL, and the header no longer claims the column drop is the only touch', () => {
    expect(doBlock).toContain('GROUP BY cl.tenant_id, cl.name');
    expect(doBlock).toContain('HAVING count(*) > 1');
    expect(doBlock).toContain('RAISE EXCEPTION');
    expect(doBlock).toMatch(/JOIN company c ON c\.id = cl\.company_id/);
    // Before step 1 — the whole block precedes the first DROP POLICY.
    expect(migration.indexOf('DO $$')).toBeLessThan(migration.indexOf('DROP POLICY "clocking_location_rls"'));
    expect(migration).not.toContain('the column drop is the only thing');
  });

  /**
   * BEHAVIOURAL, on this namespace's test DB, which is already migrated THROUGH 0459 (so the real table has
   * no company_id). Temporary tables with the PRE-0459 shape shadow `clocking_location`, `company` and
   * `employee_clocking_location` for one transaction (pg_temp is searched before public), the migration's
   * own DO block text runs against them, and the transaction rolls back — nothing real is touched. This
   * proves the pre-flight fires on a collision and names it; it does NOT re-run the drizzle migrator
   * against a 0458 snapshot (the verifier did that on a scratch DB).
   */
  describe('behaviour', () => {
    beforeAll(async () => {
      await migrateTestDb();
    });
    afterAll(async () => {
      await closeAll();
    });

    const shadow = async (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) => {
      await tx.execute(
        sql`CREATE TEMP TABLE clocking_location (tenant_id uuid NOT NULL, company_id uuid NOT NULL, name text NOT NULL, archived_at timestamptz) ON COMMIT DROP`,
      );
      await tx.execute(sql`CREATE TEMP TABLE company (id uuid PRIMARY KEY, company_label text, legal_name text NOT NULL) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE employee_clocking_location (id uuid) ON COMMIT DROP`);
    };
    const messages = (e: unknown): string => {
      let out = '';
      let cur = e as { message?: string; cause?: unknown } | null | undefined;
      for (let i = 0; cur && i < 4; i++) {
        out += cur.message ?? '';
        cur = cur.cause as { message?: string; cause?: unknown } | null | undefined;
      }
      return out;
    };

    it('STOPS with the colliding names and companies spelled out when two companies hold one name', async () => {
      const tenant = randomUUID();
      const alpha = randomUUID();
      const beta = randomUUID();
      const err: unknown = await owner.db
        .transaction(async (tx) => {
          await shadow(tx);
          await tx.execute(sql`INSERT INTO company VALUES (${alpha}, NULL, 'Alpha Sdn Bhd'), (${beta}, 'Beta', 'Beta Sdn Bhd')`);
          await tx.execute(
            sql`INSERT INTO clocking_location (tenant_id, company_id, name, archived_at) VALUES
              (${tenant}, ${alpha}, 'HQ Tower — Main Gate', NULL),
              (${tenant}, ${beta}, 'HQ Tower — Main Gate', now()),
              (${tenant}, ${alpha}, 'Plant 2', NULL)`,
          );
          await tx.execute(sql.raw(doBlock));
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err, 'the DO block must raise on a same-name collision').toBeTruthy();
      const text = messages(err);
      expect(text).toContain('0459 STOPPED before changing anything');
      // Both companies, by label where one is set, and the archived copy counts.
      expect(text).toContain('"HQ Tower — Main Gate" (Alpha Sdn Bhd, Beta)');
      expect(text).toContain('Rename the duplicates');
      // A name held by one company only is not reported.
      expect(text).not.toContain('Plant 2');
    });

    it('does NOT stop when every name is unique within its tenant — the same name in two TENANTS is fine', async () => {
      const t1 = randomUUID();
      const t2 = randomUUID();
      const co1 = randomUUID();
      const co2 = randomUUID();
      await owner.db.transaction(async (tx) => {
        await shadow(tx);
        await tx.execute(sql`INSERT INTO company VALUES (${co1}, NULL, 'One Sdn Bhd'), (${co2}, NULL, 'Two Sdn Bhd')`);
        await tx.execute(
          sql`INSERT INTO clocking_location (tenant_id, company_id, name, archived_at) VALUES
            (${t1}, ${co1}, 'HQ Tower — Main Gate', NULL),
            (${t2}, ${co2}, 'HQ Tower — Main Gate', NULL),
            (${t1}, ${co1}, 'Plant 2', NULL)`,
        );
        // Resolves: the NOTICE is printed, no exception.
        await tx.execute(sql.raw(doBlock));
      });
    });
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
    /**
     * r272 (0e8cf366) — THE PROTECTION SURVIVES, THE SENTENCE DOES NOT.
     *
     * f9afd1ce's rule was: the empty state must not claim clock-in is unavailable when shared sites
     * exist. It met that rule by reporting how many clocking points were linked to the employee's work
     * location. That sentence was itself the problem the reporter filed 0e8cf366 about — it is the card
     * telling you about their BRANCH when the engine has never consulted one — so it is gone.
     *
     * The rule is met a better way now. The empty state names the actual reason nothing resolves (nothing
     * is assigned) and the actual consequence (with geofencing enforced, that employee is refused
     * everywhere — `resolveGeofence` fails closed on zero assigned sites). It blames neither the work
     * location nor the shared register, which is what the original assertion was defending.
     */
    expect(page).not.toContain('resolvedLocationPointCount');
    expect(page, 'the empty state is about the ASSIGNMENT').toContain("tc('noneAssigned')");
    const en = JSON.parse(read('messages/en.json'));
    const empty = en.people.detail.clocking.noneAssigned as string;
    expect(empty, 'it must not blame the work location or the branch').not.toMatch(/work location|branch/i);
    expect(empty, 'and it states the real consequence').toMatch(/cannot clock in/i);
    expect(page).not.toContain("tc('noSites')");
  });

  it('the locations page renders ONE tenant-level block and NO clocking form; the page of its own gates on isGroupAdmin and posts no companyId (rev 2, r267)', () => {
    const page = read('app/admin/locations/page.tsx');
    expect(page).toContain('const groupAdmin = isGroupAdmin(s);');
    expect(page).toContain('await listClockingLocations(s, { includeArchived: true })');
    expect(page).toContain("t('sharedManagedByGroupAdmin')");
    expect(page).toContain("t('usedBy')");
    // rev 2 (r267): the create / edit forms MOVED to app/admin/locations/clocking/*. The list posts nothing
    // for a site beyond Archive / Restore / Delete; the form of its own is gated the way the list's was.
    expect(page).not.toContain('action={createClockingLocationAction}');
    expect(page).not.toContain('action={updateClockingLocationAction}');
    const form = read('app/admin/locations/clocking/clocking-form.tsx');
    expect(form).toContain("action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}");
    // The clocking form used to carry <input type="hidden" name="companyId" …> — only the per-company
    // `location` form on the list may still post one.
    expect(form).not.toContain('name="companyId"');
    for (const rel of ['app/admin/locations/clocking/new/page.tsx', 'app/admin/locations/clocking/[id]/page.tsx']) {
      const src = read(rel);
      expect(src, `${rel} gates the form on isGroupAdmin`).toContain('const groupAdmin = isGroupAdmin(s);');
      expect(src, `${rel} gives a company-scoped admin the same note the list gives them`).toContain("t('sharedManagedByGroupAdmin')");
    }
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
        // rev 2 (r267): the page of its own and the report label.
        'reportLabel',
        'reportLabelHint',
        'addClocking',
        'edit',
        'newClockingTitle',
        'editClockingTitle',
        'backToLocations',
        'sectionGps',
        'radiusMetresLabel',
        'cancel',
        'saved',
      ]) {
        expect(m.admin.locations[k], `${loc} admin.locations.${k}`).toBeTruthy();
      }
      expect(m.admin.locations.noLocationsForCompany, `${loc} retired key`).toBeUndefined();
      /**
       * 0fe1ca2e rev 6 (r335) — MOVED FROM THE MUST-EXIST LIST ABOVE TO HERE, which is the whole of the
       * round in one line. "Location information" was the heading of the first of two cards; the reporter
       * contested the card boundary between the address search and the coordinate boxes it fills, so the
       * form is ONE section under `sectionGps` now and nothing renders `sectionInfo`. A heading no screen
       * renders is a string the next reader has to prove is dead, so it is deleted rather than orphaned —
       * asserted absent in all six locales so a merge of an older branch cannot resurrect it silently
       * (CLAUDE.md §10: a naive deep-merge of messages/*.json brings deleted keys back).
       */
      expect(m.admin.locations.sectionInfo, `${loc} retired with the second card (r335)`).toBeUndefined();
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
