/**
 * Personnel (Admin) — Qualification tab (feedback a949184a). Covers: admin CRUD (add/list/update/archive),
 * catalog-backed qualification validation (active-option rule, legacy tolerance, empty-catalog
 * backward-compat), the date rules (YYYY-MM periods, From ≤ To, Graduation ≥ From, blank graduation OK),
 * the SINGLE-HIGHEST rule (transactional transfer on add and edit, plus the partial-unique-index race
 * backstop), archive semantics (soft-delete; an archived highest never blocks a new one), RLS edges
 * (self-read via can_see_employment; no cross-employee read; admin-only writes), the DomainEvent substrate
 * (events appended; free-text detail stays OUT of payloads), the qualificationLevel seed, and a
 * source-static drift guard for the new profile tab (the test/personnel-bank-statutory-tab.test.ts
 * precedent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  listQualifications,
  addQualification,
  updateQualification,
  archiveQualification,
  QualificationValidationError,
  QUALIFICATION_LEVEL_CATEGORY,
  QUALIFICATION_LEVEL_DEFAULTS,
} from '../core/qualifications';
import {
  createProfileOption,
  listProfileOptions,
  seedProfileOptions,
  setProfileOptionActive,
} from '../core/profile-options';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('Personnel — Qualification tab (a949184a)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('admin add / list / update / archive happy path, sorted graduation-desc with in-progress last', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Person');
    const bach = await addQualification(a, {
      employmentId: e.employmentId,
      qualification: 'Bachelor',
      description: 'Accounting degree',
      fromYm: '2014-09',
      toYm: '2018-06',
      institute: 'University Malaya',
      major: 'Accounting',
      graduationDate: '2018-07-15',
      result: 'First Class Honours',
      isHighest: true,
    });
    await addQualification(a, {
      employmentId: e.employmentId,
      qualification: 'Diploma',
      institute: 'TAR UMT',
      major: 'Business Studies',
      graduationDate: '2015-05-20',
    });
    // Still-in-progress record (blank graduation date is explicitly allowed) sorts last.
    await addQualification(a, {
      employmentId: e.employmentId,
      qualification: 'Master',
      fromYm: '2025-01',
    });

    let rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.qualification)).toEqual(['Bachelor', 'Diploma', 'Master']);
    expect(rows[0].institute).toBe('University Malaya');
    expect(rows[0].major).toBe('Accounting');
    expect(rows[0].fromYm).toBe('2014-09');
    expect(rows[0].toYm).toBe('2018-06');
    expect(rows[0].graduationDate).toBe('2018-07-15');
    expect(rows[0].result).toBe('First Class Honours');
    expect(rows[0].description).toBe('Accounting degree');
    expect(rows[0].isHighest).toBe(true);

    await updateQualification(a, { id: bach.id, result: 'Second Class Upper', institute: 'UM' });
    rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows[0].result).toBe('Second Class Upper');
    expect(rows[0].institute).toBe('UM');
    expect(rows[0].major).toBe('Accounting'); // unpatched fields untouched

    await archiveQualification(a, { id: bach.id });
    rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows).toHaveLength(2); // soft-deleted → not listed
    expect(rows.map((r) => r.qualification)).toEqual(['Diploma', 'Master']);
  });

  it('date rules: bad YM format, From > To, and Graduation < From are rejected (add AND effective edit)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Dates');
    await expect(
      addQualification(a, { employmentId: e.employmentId, qualification: 'Diploma', fromYm: '2020-13' }),
    ).rejects.toThrow(QualificationValidationError);
    await expect(
      addQualification(a, { employmentId: e.employmentId, qualification: 'Diploma', fromYm: 'nonsense' }),
    ).rejects.toThrow(QualificationValidationError);
    await expect(
      addQualification(a, {
        employmentId: e.employmentId, qualification: 'Diploma', fromYm: '2020-09', toYm: '2019-06',
      }),
    ).rejects.toThrow(QualificationValidationError);
    await expect(
      addQualification(a, {
        employmentId: e.employmentId, qualification: 'Diploma', fromYm: '2020-09', graduationDate: '2019-01-01',
      }),
    ).rejects.toThrow(QualificationValidationError);
    // Graduating within the From month is valid (month-precision comparison), as is a blank graduation.
    const ok = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Diploma', fromYm: '2020-09', graduationDate: '2020-09-30',
    });
    // An edit is validated against the EFFECTIVE record: moving From past the stored To must fail…
    await updateQualification(a, { id: ok.id, toYm: '2022-06' });
    await expect(updateQualification(a, { id: ok.id, fromYm: '2022-07' })).rejects.toThrow(
      QualificationValidationError,
    );
    // …and blanking a name-level field is not possible (qualification stays required).
    await expect(updateQualification(a, { id: ok.id, qualification: '   ' })).rejects.toThrow(
      QualificationValidationError,
    );
  });

  it('catalog rule: unknown/inactive values rejected as NEW picks; unchanged re-save survives; empty catalog permissive', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Catalog');
    // EMPTY catalog (tenant never seeded) imposes no constraint — free-text backward-compat.
    const free = await addQualification(a, { employmentId: e.employmentId, qualification: 'Homeschool Diploma' });
    expect(free.id).toBeTruthy();

    await seedProfileOptions(a); // seeds the nine qualificationLevel defaults
    // Now a NEW off-catalog pick is rejected…
    await expect(
      addQualification(a, { employmentId: e.employmentId, qualification: 'Fake Degree' }),
    ).rejects.toThrow(QualificationValidationError);
    // …but the stored off-catalog value keeps re-saving (unchanged → legacy tolerance).
    await updateQualification(a, { id: free.id, qualification: 'Homeschool Diploma', result: 'Pass' });

    // A deactivated option is rejected as a NEW pick, while rows already holding it keep saving.
    const { id } = await addQualification(a, { employmentId: e.employmentId, qualification: 'Diploma' });
    const [opt] = (await listProfileOptions(a, QUALIFICATION_LEVEL_CATEGORY)).filter((o) => o.value === 'Diploma');
    await setProfileOptionActive(a, { id: opt.id, isActive: false });
    await updateQualification(a, { id, qualification: 'Diploma', institute: 'TAR UMT' }); // unchanged → allowed
    await expect(
      addQualification(a, { employmentId: e.employmentId, qualification: 'Diploma' }),
    ).rejects.toThrow(QualificationValidationError);

    // A tenant-added custom option is accepted like any other active option.
    await createProfileOption(a, { category: QUALIFICATION_LEVEL_CATEGORY, value: 'Professional Membership' });
    const custom = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Professional Membership',
    });
    expect(custom.id).toBeTruthy();
  });

  it('single highest: ticking a new record transfers the flag on add and on edit', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Highest');
    const dip = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Diploma', isHighest: true,
    });
    // Adding a new highest clears the previous holder in the same transaction.
    const bach = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Bachelor', isHighest: true,
    });
    let rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows.filter((r) => r.isHighest).map((r) => r.id)).toEqual([bach.id]);
    // The transfer is recorded on the event (ids only — no free-text detail).
    const addedPayload = await latestEventPayload(base.tenantId, bach.id, 'qualification.added');
    expect((addedPayload as { clearedHighestId?: string }).clearedHighestId).toBe(dip.id);

    // EDIT transfer: re-ticking the diploma moves the flag back.
    await updateQualification(a, { id: dip.id, isHighest: true });
    rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows.filter((r) => r.isHighest).map((r) => r.id)).toEqual([dip.id]);
    const updatedPayload = await latestEventPayload(base.tenantId, dip.id, 'qualification.updated');
    expect((updatedPayload as { clearedHighestId?: string }).clearedHighestId).toBe(bach.id);

    // Highest is PER EMPLOYMENT: another employee's highest is unaffected.
    const e2 = await hire(a, base, 'Qual Other');
    await addQualification(a, { employmentId: e2.employmentId, qualification: 'Master', isHighest: true });
    expect(
      (await listQualifications(a, { employmentId: e.employmentId })).filter((r) => r.isHighest),
    ).toHaveLength(1);
  });

  it('single highest: the partial unique index is the race backstop for a concurrent double-highest', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Race');
    await addQualification(a, { employmentId: e.employmentId, qualification: 'Diploma', isHighest: true });
    // A write that skips the service's transactional clear (the concurrent-transaction shape) hits the
    // partial unique index — a second live highest is structurally impossible. Drizzle wraps the Postgres
    // unique-violation, so the constraint name is asserted via the error CAUSE chain.
    let err: unknown;
    try {
      await owner.db.insert(schema.employeeQualification).values({
        tenantId: base.tenantId,
        employmentId: e.employmentId,
        qualification: 'Bachelor',
        isHighest: true,
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeTruthy();
    const cause = (err as Error).cause ?? err;
    expect(`${(cause as Error).message}`).toMatch(/employee_qualification_one_highest_uq/);
  });

  it('archive semantics: an archived highest never blocks a new highest', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Archive');
    const dip = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Diploma', isHighest: true,
    });
    await archiveQualification(a, { id: dip.id });
    // The archived row keeps its flag value but is outside the partial index — a new highest is fine.
    const bach = await addQualification(a, {
      employmentId: e.employmentId, qualification: 'Bachelor', isHighest: true,
    });
    const rows = await listQualifications(a, { employmentId: e.employmentId });
    expect(rows.map((r) => r.id)).toEqual([bach.id]);
    // Double-archive is rejected like any missing record.
    await expect(archiveQualification(a, { id: dip.id })).rejects.toThrow(QualificationValidationError);
  });

  it('RLS: self-read allowed; no cross-employee read; writes admin-only', async () => {
    const a = adminCtx(base);
    const me = await hire(a, base, 'Qual Self');
    const other = await hire(a, base, 'Qual Peer');
    await addQualification(a, { employmentId: me.employmentId, qualification: 'Diploma' });
    await addQualification(a, { employmentId: other.employmentId, qualification: 'Master' });

    const uSelf = await createAppUser(base.tenantId, me.personId, 'employee');
    const selfCtx: SessionContext = { tenantId: base.tenantId, userId: uSelf, roles: ['employee'] };

    // can_see_employment grants SELF read of their own qualification history…
    expect((await listQualifications(selfCtx, { employmentId: me.employmentId })).map((r) => r.qualification)).toEqual([
      'Diploma',
    ]);
    // …but NOT another employee's (RLS filters, not errors).
    expect(await listQualifications(selfCtx, { employmentId: other.employmentId })).toEqual([]);
    // And writes are admin-only (RLS WITH CHECK is_admin()).
    await expect(
      addQualification(selfCtx, { employmentId: me.employmentId, qualification: 'PhD' }),
    ).rejects.toThrow();
  });

  it('DomainEvents: appended on add/update/archive; free-text detail stays OUT of every payload', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Qual Events');
    const { id } = await addQualification(a, {
      employmentId: e.employmentId,
      qualification: 'Bachelor',
      description: 'Secret Description',
      institute: 'Secret Institute',
      major: 'Secret Major',
      result: 'Secret Result',
      isHighest: true,
    });
    await updateQualification(a, { id, institute: 'Renamed Institute' });
    await archiveQualification(a, { id });

    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining(['qualification.added', 'qualification.updated', 'qualification.archived']),
    );
    // The update payload is field NAMES only.
    const upd = await latestEventPayload(base.tenantId, id, 'qualification.updated');
    expect((upd as { diff: string[] }).diff).toEqual(['institute']);
    // No free-text detail in any payload (the catalog value + flags are the only data carried).
    for (const t of ['qualification.added', 'qualification.updated', 'qualification.archived']) {
      const payload = await latestEventPayload(base.tenantId, id, t);
      const serialized = JSON.stringify(payload ?? {});
      expect(serialized).not.toContain('Secret');
      expect(serialized).not.toContain('Renamed Institute');
    }
  });

  it('seedProfileOptions seeds the approved qualificationLevel default list, in order', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const seeded = await listProfileOptions(a, QUALIFICATION_LEVEL_CATEGORY);
    expect(seeded.map((o) => o.value)).toEqual([...QUALIFICATION_LEVEL_DEFAULTS]);
    expect(seeded.map((o) => o.value)).toEqual([
      'SPM', 'STPM', 'Certificate', 'Diploma', 'Advanced Diploma',
      'Bachelor', 'Master', 'Doctorate', 'Professional Certification',
    ]);
  });
});

// ── Drift guard — the Qualification tab on the Personnel (Admin) profile ─────────────────────────────
// Source-static checks (the test/personnel-bank-statutory-tab.test.ts precedent): a refactor must not
// silently drop the tab, its panel wiring, or a locale's tab label.
describe('Personnel — Qualification tab drift guard (a949184a)', () => {
  const PAGE = fs.readFileSync(
    path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
    'utf8',
  );
  const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

  it('registers the qualification tab in the tab strip', () => {
    expect(PAGE.includes("{ key: 'qualification', label: t('tabs.qualification') }")).toBe(true);
  });

  it('mirrors the new key in the ClientTabs PersonnelTabKey union', () => {
    expect(TABS.includes("'qualification'")).toBe(true);
  });

  it('wires the qualification panel into the panels record', () => {
    expect(PAGE.includes('qualification: qualificationPanel,')).toBe(true);
    expect(PAGE.includes('const qualificationPanel = admin ?')).toBe(true);
  });

  it('renders the list-and-dialog register: summary columns, Add dialog, edit/delete actions', () => {
    // Summary table columns per the request: Qualification / Institute / Major / Graduation Date / Highest.
    for (const key of [
      'qualification.level',
      'qualification.institute',
      'qualification.major',
      'qualification.graduationDate',
      'qualification.highestColumn',
    ]) {
      expect(PAGE.includes(`t('${key}')`), `missing column label ${key}`).toBe(true);
    }
    // Add / Edit post to the event-logged actions; Delete confirms through ConfirmSubmit.
    expect(PAGE.includes('addQualificationAction')).toBe(true);
    expect(PAGE.includes('editQualificationAction')).toBe(true);
    expect(PAGE.includes('archiveQualificationAction')).toBe(true);
    // Tab retention: the dialog form carries the static hidden tab field (Dialog.Portal escapes the shell).
    expect(PAGE.includes('<input type="hidden" name="tab" value="qualification" data-tab-tracker="" />')).toBe(true);
  });

  it('has the tab label and card namespace in all six locales', () => {
    for (const loc of LOCALES) {
      const messages = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      ) as { people: { detail: { tabs: Record<string, string>; qualification?: Record<string, string> } } };
      expect(messages.people.detail.tabs.qualification, `[${loc}] missing tabs.qualification`).toBeTruthy();
      expect(messages.people.detail.qualification?.title, `[${loc}] missing qualification.title`).toBeTruthy();
      expect(messages.people.detail.qualification?.highest, `[${loc}] missing qualification.highest`).toBeTruthy();
    }
  });
});
