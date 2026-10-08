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
 *     forms live on a page of their own (app/admin/work-locations/clocking/*) and the list carries none.
 *
 * Behaviour (the 42501, the service refusal, cross-company assignment landing, the optional link) lives in
 * test/clocking-geofence.test.ts. This file pins the SHAPE those behaviours depend on.
 *
 * r423 (83c0d3c8, migration 0517) — the location stays ONE shared record written by group admins, but is now
 * OPENED TO NAMED COMPANIES (clocking_location_company). Three f9afd1ce pins below are REVERSED and pin the
 * new rule: the personnel picker offers only the locations open to the employee's company; the list reads
 * the companies a location is open to (not a "Used by" derived from assignments); and the create action
 * posts the companies (`companyIds`) — still never an OWNER company. 0517's own shape is pinned in its own
 * describe at the end.
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

  it('listClockingLocations FILTERS by company (r423) but no location has an owner company', () => {
    // r423 — the options are the list's filters; `companyId` is "open to this company", a filter over the
    // join table, never an owner column on the location.
    expect(service).toMatch(/export function listClockingLocations\(\s*ctx: SessionContext,\s*opts: ListClockingLocationsOptions = \{\},?\s*\)/);
    expect(service).toContain('companyId?: string;');
    expect(service).not.toContain('CrossCompanyClockingLocationError');
    expect(service).not.toContain('clockingLocation.companyId');
    // The row carries the companies the location is OPEN to; "Used by" (derived from assignments) is gone.
    expect(service).toContain('companies: ClockingLocationCompanyRef[];');
    expect(service).not.toContain('usedByCompanies');
    // A non-group-admin sees only locations open to companies they administer, and only those names.
    expect(service).toContain('app.is_admin_for(vc.company_id)');
    expect(service).toContain('(app.is_group_admin() or app.is_admin_for(clc.company_id))');
  });
});

describe('f9afd1ce / r423 — the screens', () => {
  it('r423 REVERSES "the personnel page offers EVERY shared site": only active sites open to the employee’s company', () => {
    const page = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(page).toContain('await listClockingLocations(s, { companyId: emp.companyId }) : []');
    expect(page).not.toContain('await listClockingLocations(s) : []');
    expect(page).not.toContain('resolvedLocationPointCount');
    /**
     * r272's protection survives: the empty state names the real reason (nothing usable is assigned) and
     * the real consequence, and blames neither the work location nor the branch. r423 says it as the plan
     * worded it ("Choose a location: this employee cannot clock in until one is assigned").
     */
    expect(page, 'the empty state is about the ASSIGNMENT').toContain("cannotClockWarning: tc('cannotClockWarning')");
    const en = JSON.parse(read('messages/en.json'));
    const empty = en.people.detail.clocking.cannotClockWarning as string;
    expect(empty, 'it must not blame the work location or the branch').not.toMatch(/work location|branch/i);
    expect(empty, 'and it states the real consequence').toMatch(/cannot clock in/i);
    expect(page).not.toContain("tc('noSites')");
  });

  it('the list renders ONE tenant-level register through the facade, gated on isGroupAdmin, with no clocking form; the form posts no owner company', () => {
    const list = read('app/admin/work-locations/clocking/page.tsx');
    const view = read('app/admin/work-locations/clocking/[id]/page.tsx');
    const page = read('app/admin/work-locations/page.tsx');
    expect(list).toContain('const groupAdmin = isGroupAdmin(s);');
    expect(list).toContain('await listClockingLocations(s, { status, q, companyId: companyId || undefined })');
    for (const src of [list, view]) expect(src, 'through the facade, never the implementation').toContain("from '@/packs/attendance/service'");
    expect(list).toContain("t('companyAdminReadOnly')");
    expect(view).toContain("t('sharedManagedByGroupAdmin')");
    expect(list).toContain("t('colCompanies')");
    expect(list).not.toContain("t('usedBy')");
    for (const src of [list, view, page]) {
      expect(src).not.toContain('action={createClockingLocationAction}');
      expect(src).not.toContain('action={updateClockingLocationAction}');
    }
    expect(page, 'the work location listing renders no form at all').not.toContain('<form');
    const form = read('app/admin/work-locations/clocking/clocking-form.tsx');
    expect(form).toContain("action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}");
    expect(form, 'no OWNER company field').not.toContain('name="companyId"');
    expect(form, 'the companies ALLOWED to use it, one tick each').toContain('name="companyIds"');
    const newPage = read('app/admin/work-locations/clocking/new/page.tsx');
    expect(newPage).toContain('const groupAdmin = isGroupAdmin(s);');
    expect(newPage).toContain("t('sharedManagedByGroupAdmin')");
    expect(read('app/admin/work-locations/clocking/[id]/edit/page.tsx')).toContain('if (!isGroupAdmin(s)) redirect(clockingViewPage(site.id));');
  });

  it('the create action posts the companies allowed (companyIds), never an owner companyId', () => {
    const actions = read('app/admin/actions.ts');
    const from = actions.indexOf('export async function createClockingLocationAction');
    const to = actions.indexOf('export async function updateClockingLocationAction');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const fn = actions.slice(from, to);
    expect(fn).not.toMatch(/\bcompanyId\b/);
    expect(fn).toContain('companyIds,');
  });

  it('the six locales carry every live key, the retired ones are marked retired, and the long-deleted stay deleted', () => {
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as {
        admin: { locations: Record<string, string> };
        people: { detail: { clocking: Record<string, string> } };
      };
      for (const k of [
        'sharedManagedByGroupAdmin',
        'radiusMetres',
        'clockingLocationLinkOptional',
        'clockingLocationNone',
        'noSharedSites',
        'reportLabel',
        'reportLabelHint',
        'edit',
        'newClockingTitle',
        'editClockingTitle',
        'backToLocations',
        'sectionGps',
        'radiusMetresLabel',
        'cancel',
        'saved',
        // r423 — the list, the form's new sections, and the work location listing's own title.
        'pageTitle',
        'workLocationsTitle',
        'colCompanies',
        'sectionCompanies',
        'sectionStatus',
        'companiesRequired',
        'companyInUse',
        'deactivateConfirmDescription',
      ]) {
        expect(m.admin.locations[k], `${loc} admin.locations.${k}`).toBeTruthy();
        expect(m.admin.locations[k], `${loc} admin.locations.${k} is live`).not.toMatch(/^\[retired/);
      }
      // r423 — no screen renders these any more; retired in place (i18n/request.ts deep-merges each locale
      // over English, so removing a key from en.json alone would leave the old sentence for a Malay reader).
      for (const k of ['usedBy', 'coordinates', 'linkedOutOfScopeGroupTitle', 'addClocking', 'clockingPointsHeading', 'offRegisterTitle', 'offRegisterDescription', 'offRegisterLink']) {
        expect(m.admin.locations[k], `${loc} admin.locations.${k} retired in r423`).toMatch(/^\[retired r423 — /);
      }
      for (const k of ['noSharedSites', 'linkedPoints', 'geofencingToggle', 'radiusOverrideLabel']) {
        expect(m.people.detail.clocking[k], `${loc} people.detail.clocking.${k} retired in r423`).toMatch(/^\[retired r423 — /);
      }
      expect(m.admin.locations.noLocationsForCompany, `${loc} retired key`).toBeUndefined();
      expect(m.admin.locations.clockingSharedTitle, `${loc} retired with the tenant-wide register (r338)`).toBeUndefined();
      expect(m.admin.locations.clockingHeading, `${loc} retired with the tenant-wide register (r338)`).toBeUndefined();
      expect(m.admin.locations.sectionInfo, `${loc} retired with the second card (r335)`).toBeUndefined();
      expect(m.people.detail.clocking.noSites, `${loc} retired key`).toBeUndefined();
    }
  });
});

describe('f9afd1ce — ADR-0070 records the amendment rather than being rewritten', () => {
  const adr = read('docs/adr/0070-clocking-locations-geofencing.md');
  it('keeps the original §2 text and appends the amendments', () => {
    expect(adr).toContain('### 2. RLS: tenant-catalog read, company-admin write (mirrors 0065 `pay_component`)');
    expect(adr).toContain('Amended 2026-09-11 (f9afd1ce)');
    expect(adr).toContain('Amended 2026-10-08 (r423, 83c0d3c8)');
  });
});

/**
 * r423 (83c0d3c8) — migration 0517: the companies a shared location is open to, and the switch.
 * Shape here; the backfill behaviour is in test/r423-clocking-location-companies.test.ts.
 */
describe('r423 — migration 0517 is journalled and says what it must', () => {
  const m517 = read('db/migrations/0517_clocking_location_companies.sql');
  it('idx 517, tag matching, `when` above 0515 AND above the unmerged 0516 branch (1791500000000)', () => {
    const e517 = journal.entries.find((e) => e.idx === 517);
    const e515 = journal.entries.find((e) => e.idx === 515);
    expect(e517?.tag).toBe('0517_clocking_location_companies');
    expect(e517!.when).toBeGreaterThan(e515!.when);
    expect(e517!.when).toBeGreaterThan(1791500000000);
  });
  it('RLS: INSERT and DELETE are group-admin; SELECT is group admin, company admin, or an employee of the company; GRANT to ai_hr_app', () => {
    expect(m517).toContain('ALTER TABLE "clocking_location_company" ENABLE ROW LEVEL SECURITY');
    expect(m517).toMatch(/clocking_location_company_insert"[\s\S]*?WITH CHECK \(tenant_id = app\.current_tenant_id\(\) AND app\.is_group_admin\(\)\)/);
    expect(m517).toMatch(/clocking_location_company_delete"[\s\S]*?USING \(tenant_id = app\.current_tenant_id\(\) AND app\.is_group_admin\(\)\)/);
    const select = m517.slice(m517.indexOf('CREATE POLICY "clocking_location_company_select"'), m517.indexOf('CREATE POLICY "clocking_location_company_insert"'));
    expect(select.length).toBeGreaterThan(100);
    expect(select).toContain('app.is_admin_for(company_id)');
    expect(select).toContain('app.is_self_person(e.person_id)');
    expect(m517, 'no UPDATE policy: a row is added or removed, never edited').not.toContain('clocking_location_company_update');
    expect(m517).toContain('GRANT SELECT, INSERT, DELETE ON "clocking_location_company" TO ai_hr_app');
  });
  it('adds state, flips the switch on for assigned employees, relaxes the three capture columns, and counts everything', () => {
    expect(m517).toContain('ALTER TABLE "clocking_location" ADD COLUMN "state" text');
    expect(m517).toContain('UPDATE employment e SET geofencing_enabled = true');
    for (const col of ['clocking_location_id', 'distance_m', 'radius_m']) {
      expect(m517).toContain(`ALTER TABLE "attendance_clock_capture" ALTER COLUMN "${col}" DROP NOT NULL`);
    }
    expect((m517.match(/RAISE NOTICE '/g) ?? []).length, 'two counted reports, one per data block').toBe(2);
    expect(m517, 'the override column is kept').not.toContain('DROP COLUMN "geofence_radius_m"');
  });
});
