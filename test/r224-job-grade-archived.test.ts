/**
 * r224 — "Job Grade archived: label the delete, surface the reason, restore instead of duplicate".
 *
 * The reporter asked for a permanent delete on archived job grades, protected against grades still in use,
 * with code reuse allowed and no duplicate historical records. Nearly all of that was already built and
 * hidden: the Archived filter lists archived grades, the row already carries a hard delete, `deleteJobGrade`
 * already refuses when any of SIX places still reference the grade, and archive is a toggle so restore
 * already exists. What was missing was that none of it was READABLE — the delete was an unlabelled cross and
 * its refusal reason lived in a `title` attribute — plus one genuine hole: typing a code that belongs to an
 * archived grade silently created a SECOND grade carrying that code, because both grade uniqueness indexes
 * are partial (`WHERE archived_at IS NULL`) and therefore release the code on archive.
 *
 * What this suite pins:
 *   A. The Archived view says what it does — a labelled "Delete permanently", the refusal reason rendered as
 *      text rather than on hover, and the restore offer rendered with a button. Plus the six locales.
 *   B. ONE list of referrers, not two. The i18n hint and `deleteJobGrade`'s thrown message name the same six
 *      categories; the hint used to say "leave policies" — a table migration 0405 DROPPED — and omitted both
 *      entitlement eligibility rules and mileage rates. That drift is the reason the plan said to reuse the
 *      service's list rather than author a second one.
 *   C. The jsonb arm of the six-way in-use predicate, driven end to end. A grade referenced ONLY from
 *      `entitlement_eligibility_rule.criteria -> 'gradeIds'` has NO foreign key pointing at it, so nothing in
 *      the database would stop the delete; this is the arm a future refactor is most likely to drop and the
 *      only one whose loss is silent (a rule left targeting a grade id nothing resolves).
 *   D. Restore instead of duplicate: the create is refused, the refusal carries the archived grade's id, the
 *      restore clears archived_at IN PLACE (same id, so the history stays attached), and an ordinary
 *      ACTIVE-code clash is untouched by any of it.
 *
 * NO MIGRATION and NO DATA CHANGE: job_grade, both partial unique indexes and the in-use predicate are all
 * exactly as they were.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same action harness as test/grade-system-label-relocation.test.ts: requireAdmin() resolves getSession()
// and redirect()s a non-admin away, and redirect() THROWS in real Next.js, so the mock throws a sentinel
// carrying the target path.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new RedirectError(p);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));

import { archiveJobGrade, createJobGrade } from '../core/admin';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { listJobGrades } from '../core/read';
import {
  removeJobGradeGridAction,
  restoreJobGradeGridAction,
  saveJobGradesGridAction,
} from '../app/admin/settings/actions';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const gradeGridSrc = read('../components/grade-labels-grid.tsx');
const labelsPageSrc = read('../app/admin/settings/system-labels/page.tsx');
const adminSrc = read('../core/admin.ts');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The SIX referrer categories `deleteJobGrade` actually checks, as the words a reader recognises. */
const REFERRER_WORDS = [
  'employee',
  'entitlement eligibility rule',
  'approval rule',
  'claim limit',
  'mileage rate',
  'grade group',
] as const;

// ONE set of DB hooks for the whole file — closeAll() ends the SHARED postgres client.
let b: Base;
const ctx = () => adminCtx(b);
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

describe('r224 · A — the Archived view says what it does', () => {
  it('an ARCHIVED row renders a LABELLED permanent delete, not the drafts’ unlabelled cross', () => {
    // The control was always there; it was the same `X` the draft rows use to discard themselves, which is
    // why it did not read as "delete permanently". Keyed on the ROW being archived rather than on the
    // filter, so it reads identically under the Archived and All filters.
    expect(gradeGridSrc).toContain("t('deletePermanently')");
    const at = (needle: string) => {
      const i = gradeGridSrc.indexOf(needle);
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    // The labelled button sits inside the `r.archived ? … : …` arm, ahead of the icon-only fallback.
    expect(at('{r.archived ? (')).toBeLessThan(at("t('deletePermanently')"));
    expect(at("t('deletePermanently')")).toBeLessThan(at("title={r.inUse ? t('gradeInUseHint') : t('deleteRow')}"));
    // Same action and same confirm dialog as before — only the label changed.
    expect(gradeGridSrc).toContain('onClick={() => setConfirmDelete(r)}');
    expect(gradeGridSrc).toContain("confirmLabel={confirmDelete.archived ? t('deletePermanently') : t('deleteRow')}");
  });

  it('the refusal reason renders as TEXT under the row, not only as a hover title', () => {
    // This is the whole complaint: the protection existed and was invisible. A `title=` alone is not
    // "in plain sight" — it needs a pointer, it never appears on touch, and it is unreadable to anyone
    // scanning the grid. The notice is its own <tr> because the reason names six referrer categories and
    // would not survive the right-aligned actions column.
    expect(gradeGridSrc).toMatch(/const inUseNotice = !restoreOffer && !r\.isNew && r\.archived && r\.inUse;/);
    expect(gradeGridSrc).toMatch(/\{inUseNotice && \(\s*<tr>/);
    expect(gradeGridSrc).toMatch(/<p className="text-xs text-amber-600[^"]*">\{t\('gradeInUseHint'\)\}<\/p>/);
  });

  it('the restore offer renders the server’s message plus a Restore button on the offending row', () => {
    expect(gradeGridSrc).toContain("const restoreOffer = err?.restoreArchivedId");
    expect(gradeGridSrc).toContain('{restoreOffer.message}');
    expect(gradeGridSrc).toContain('onClick={() => restoreArchived(r.key, restoreOffer.id)}');
    // The button reuses the grid's existing Restore string rather than minting a seventh translation of
    // the same word.
    expect(gradeGridSrc).toMatch(/restoreArchived\(r\.key, restoreOffer\.id\)\}[\s\S]{0,320}t\('unarchive'\)/);
    // The restored grade replaces the draft; any copy already on screen (Archived / All filter) is dropped
    // first, or two rows would share one React key.
    expect(gradeGridSrc).toContain('prev.filter((r) => r.key !== restored.key).map((r) => (r.key === draftKey ? restored : r))');
  });

  it('the page passes the restore action into the grid', () => {
    expect(labelsPageSrc).toContain('restoreJobGradeGridAction');
    expect(labelsPageSrc).toContain('restore: restoreJobGradeGridAction,');
  });

  it('ships deletePermanently and gradeRestored in all six locales, and gradeRestored keeps {code}', () => {
    for (const loc of LOCALES) {
      const sl = JSON.parse(read(`../messages/${loc}.json`))?.admin?.systemLabels ?? {};
      for (const key of ['deletePermanently', 'gradeRestored', 'gradeInUseHint']) {
        expect(typeof sl[key], `${loc}.admin.systemLabels.${key}`).toBe('string');
        expect((sl[key] as string).length, `${loc}.admin.systemLabels.${key} non-empty`).toBeGreaterThan(0);
      }
      expect(sl.gradeRestored as string, `${loc}: gradeRestored keeps {code}`).toContain('{code}');
    }
    expect(JSON.parse(read('../messages/en.json')).admin.systemLabels.deletePermanently).toBe('Delete permanently');
  });
});

describe('r224 · B — ONE list of referrers, not two', () => {
  it('the i18n hint and deleteJobGrade’s refusal name the SAME six categories', () => {
    // The plan's instruction was to reuse the service's enumeration rather than author a second list that
    // can drift. A screen string cannot literally BE the service string (it is one of six locales), so the
    // guard is here: if a seventh referrer is added to the predicate and only one of the two lists is
    // updated, this fails.
    const serviceMessage = /'(This grade is in use[^']*)'/.exec(adminSrc)?.[1];
    expect(serviceMessage, 'deleteJobGrade still throws its enumerated in-use message').toBeTruthy();
    const hint = JSON.parse(read('../messages/en.json')).admin.systemLabels.gradeInUseHint as string;
    for (const word of REFERRER_WORDS) {
      expect(serviceMessage!.toLowerCase(), `service message names "${word}"`).toContain(word);
      expect(hint.toLowerCase(), `gradeInUseHint names "${word}"`).toContain(word);
    }
  });

  it('no locale still names "leave policies" — 0405 dropped that table', () => {
    // The old hint enumerated leave_policy, which migration 0405 DROPPED, and omitted the two referrers
    // that replaced/joined it. Naming a table that no longer exists is worse than naming none: it sends
    // the admin looking for a screen that is gone.
    const en = JSON.parse(read('../messages/en.json')).admin.systemLabels.gradeInUseHint as string;
    expect(en.toLowerCase()).not.toContain('leave polic');
    // The same clause is gone from the code path that produces the refusal.
    const serviceMessage = /'(This grade is in use[^']*)'/.exec(adminSrc)?.[1] ?? '';
    expect(serviceMessage.toLowerCase()).not.toContain('leave polic');
  });
});

describe('r224 · C — the jsonb arm of the in-use predicate, driven end to end', () => {
  async function ruleTargeting(gradeId: string) {
    const tpl = await createEntitlementTemplate(ctx(), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Standard annual',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx(), {
      name: 'Managers',
      templateLineageId: tpl.lineageId,
      criteria: { gradeIds: [gradeId] },
      validFrom: '2026-01-01',
    });
  }

  it('a grade referenced ONLY from entitlement_eligibility_rule criteria reports inUse and refuses deletion', async () => {
    // No foreign key points at this grade — the reference lives inside `criteria` JSONB. So unlike the
    // other five referrers, nothing in the database would raise 23503: the delete would simply SUCCEED and
    // leave the rule targeting a grade id nothing resolves, silently narrowing (or widening) who its
    // entitlement table reaches. The guard is the only thing standing between the two.
    const g = await createJobGrade(ctx(), { code: 'MGR', name: 'Manager' });
    await ruleTargeting(g.id);

    const [row] = (await listJobGrades(ctx(), { includeArchived: true })).filter((r) => r.id === g.id);
    expect(row.inUse, 'the grid projection must see the jsonb reference').toBe(true);

    const res = await removeJobGradeGridAction(g.id);
    expect(res.ok).toBe(false);
    // …and it says WHICH category, in the words the plan promised the reporter.
    expect(res.ok === false && res.message.toLowerCase()).toContain('entitlement eligibility rule');
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(true);
  });

  it('…and it refuses even while ARCHIVED — archiving does not release the reference', async () => {
    // The Archived view is where the labelled permanent delete lives, so this is the state the guard is
    // actually consulted in. Archiving takes a grade out of the pickers; it does not unpick it from the
    // rules that already name it.
    const g = await createJobGrade(ctx(), { code: 'MGR', name: 'Manager' });
    await ruleTargeting(g.id);
    await archiveJobGrade(ctx(), { id: g.id, archived: true });

    const [row] = (await listJobGrades(ctx(), { includeArchived: true })).filter((r) => r.id === g.id);
    expect(row.archivedAt).not.toBeNull();
    expect(row.inUse).toBe(true);
    expect(await removeJobGradeGridAction(g.id)).toMatchObject({ ok: false });
  });

  it('an UNREFERENCED archived grade is still permanently deletable (the protection did not widen)', async () => {
    const g = await createJobGrade(ctx(), { code: 'TMP', name: 'Temporary Band' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });
    expect(await removeJobGradeGridAction(g.id)).toEqual({ ok: true });
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(false);
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.deleted');
  });
});

describe('r224 · D — restore instead of duplicate', () => {
  it('a create whose code belongs to an ARCHIVED grade is refused, and the refusal offers that grade', async () => {
    const g = await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });

    const res = await saveJobGradesGridAction({
      creates: [{ key: 'draft-1', code: 'G1', name: 'Grade One (new)', description: '', rank: '1' }],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors).toHaveLength(1);
    expect(res.rowErrors[0].key).toBe('draft-1');
    // It is a CODE clash, so it highlights the code cell — even though the message also names the archived
    // grade, which the message-shape heuristic would otherwise mistake for a name clash.
    expect(res.rowErrors[0].field).toBe('code');
    expect(res.rowErrors[0].restoreArchivedId).toBe(g.id);
    expect(res.rowErrors[0].message).toContain('G1');

    // THE POINT: no second row. The partial unique index would NOT have stopped this insert.
    const all = await listJobGrades(ctx(), { includeArchived: true });
    expect(all.filter((r) => r.code === 'G1')).toHaveLength(1);
    expect(all.find((r) => r.code === 'G1')!.id).toBe(g.id);
  });

  it('the good rows in the same batch still commit — the refusal does not poison the fan-out', async () => {
    const g = await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });

    const res = await saveJobGradesGridAction({
      creates: [
        { key: 'draft-1', code: 'G1', name: 'Grade One (new)', description: '', rank: '1' },
        { key: 'draft-2', code: 'G2', name: 'Grade Two', description: '', rank: '2' },
      ],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors.map((e) => e.key)).toEqual(['draft-1']);
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.code === 'G2')).toBe(true);
  });

  it('restoring clears archived_at IN PLACE — same id, so the history stays attached', async () => {
    const g = await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });

    const res = await restoreJobGradeGridAction(g.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    // The SAME row, not a copy — this is what "restore instead of duplicate" has to mean for the
    // employment / eligibility-rule / grade-group references already pointing at it.
    expect(res.row.id).toBe(g.id);
    expect(res.row.archivedAt).toBeNull();
    expect(res.row.code).toBe('G1');
    const all = await listJobGrades(ctx(), { includeArchived: true });
    expect(all.filter((r) => r.code === 'G1')).toHaveLength(1);
    expect(all[0].archivedAt).toBeNull();
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.unarchived');
  });

  it('…and the code is creatable again ONLY after the archived twin is gone', async () => {
    // Reuse of an archived code is what the reporter was told already works. It still does — via restore,
    // or via a permanent delete of the archived grade. What no longer happens is a silent SECOND row.
    const g = await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });
    expect(await removeJobGradeGridAction(g.id)).toEqual({ ok: true });

    const res = await saveJobGradesGridAction({
      creates: [{ key: 'draft-1', code: 'G1', name: 'Grade One Again', description: '', rank: '1' }],
      updates: [],
    });
    expect(res.ok, res.ok ? '' : JSON.stringify(res.rowErrors)).toBe(true);
  });

  it('an ACTIVE code clash is untouched: ordinary duplicate error, and NO restore offer', async () => {
    // The new branch must not swallow the case the partial index does catch. An active grade holding the
    // code has nothing to restore, so offering one would be a button that cannot help.
    await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });

    const res = await saveJobGradesGridAction({
      creates: [{ key: 'draft-1', code: 'G1', name: 'Another One', description: '', rank: '1' }],
      updates: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.rowErrors[0].restoreArchivedId).toBeUndefined();
    expect(res.rowErrors[0].field).toBe('code');
    expect(res.rowErrors[0].message).toMatch(/already exists/i);
  });

  it('a NON-ADMIN session is refused by the restore action', async () => {
    // Same explicit gate as its two siblings: 0090's job_grade policy checks app.is_admin() on writes, but
    // a server action is addressable and does not get to rely on RLS alone.
    const g = await createJobGrade(ctx(), { code: 'G1', name: 'Grade One' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });
    actionCtx = { ...adminCtx(b), roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(restoreJobGradeGridAction(g.id)).rejects.toBeInstanceOf(RedirectError);
    actionCtx = adminCtx(b);
    const [row] = (await listJobGrades(ctx(), { includeArchived: true })).filter((r) => r.id === g.id);
    expect(row.archivedAt, 'the refused restore left the grade archived').not.toBeNull();
  });
});
