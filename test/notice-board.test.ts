/**
 * 6e122302 — the Notice Board: publish, target, derive, and the two surfaces that show a notice unasked.
 *
 * The specs below are chosen for the ways THIS design goes quietly wrong, not for coverage:
 *
 *   • THE AUDIENCE SNAPSHOT. The single most consequential decision in the item is that publishing
 *     resolves the audience ONCE. The spec that matters is not "publish writes recipient rows" — it is
 *     that transferring an employee afterwards does NOT change who the notice reached. Every other
 *     property of the module is recoverable; a retrospectively-changing audience is not.
 *   • THE DERIVED STATUS. Draft/scheduled/active/expired/archived come from dates, so the failure mode is
 *     a boundary being wrong by a day, in either direction, on the two days that matter.
 *   • THE GENERALISED RESOLVER. The whole point of lifting the resolver out of core/leave-adjustment.ts is
 *     that both callers select the SAME PEOPLE. That is asserted directly, not assumed from the types.
 *   • THE i18n KEYS CHECK C CANNOT SEE. `t(`status.${x}`)` is a computed key, and the criteria vocabulary
 *     lives in a three-namespace file that check C skips entirely — the exact hole r127 shipped twelve
 *     MISSING_MESSAGE labels through. Both are pinned here by enumeration.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import en from '../messages/en.json';
import { hireEmployee } from '../core/org';
import { withTenant } from '../db/client';
import { ORG_ASSIGNMENT_CRITERIA } from '../core/leave-org-criteria';
import { resolveOrgCriteriaTargets, orgCriteriaFromFields, isUnrestrictedOrgCriteria } from '../core/org-criteria';
import { resolveAdjustmentTargets } from '../core/leave-adjustment';
import {
  NOTICE_STATUSES,
  NoticeError,
  archiveNotice,
  createNotice,
  deleteNotice,
  deriveNoticeStatus,
  duplicateNotice,
  getNotice,
  listNotices,
  noticesForEmployment,
  popupNoticeFor,
  publishNotice,
  unreadNoticeCount,
  updateNotice,
  type EmployeeNoticeRow,
} from '../core/notice';
import { EMPLOYMENT_TYPE_VALUES } from '../app/admin/notice-board/criteria-options';
import { dispatchNotifications } from '../core/notifications';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

async function hire(name: string, opts: { deptId?: string; hiredOn?: string } = {}): Promise<string> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `notice_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: opts.deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2020-01-01',
  });
  return e.employmentId;
}

const draft = (over: Partial<Parameters<typeof createNotice>[1]> = {}) =>
  createNotice(adminCtx(b), {
    title: 'Annual Leave Policy',
    body: 'Please read the updated policy.',
    startOn: '2026-01-01',
    endOn: '2026-12-31',
    ...over,
  });

const recipientsOf = async (noticeId: string): Promise<string[]> => {
  const rows = await owner.db
    .select({ e: schema.noticeRecipient.employmentId })
    .from(schema.noticeRecipient)
    .where(eq(schema.noticeRecipient.noticeId, noticeId));
  return rows.map((r) => r.e).sort();
};

// ─────────────────────────── status derivation ───────────────────────────

describe('6e122302 · status is DERIVED, never stored', () => {
  const win = { startOn: '2026-03-01', endOn: '2026-03-31' };
  const published = new Date('2026-02-01T00:00:00Z');

  it('a notice with no publishedAt is a draft, whatever its dates say', () => {
    expect(deriveNoticeStatus({ ...win, publishedAt: null, archivedAt: null }, '2026-03-15')).toBe('draft');
    // Even one whose window has already passed: it was never published, so it never happened.
    expect(deriveNoticeStatus({ ...win, publishedAt: null, archivedAt: null }, '2027-01-01')).toBe('draft');
  });

  it('archived WINS over every other state — a withdrawn notice is not "active" because today is in range', () => {
    const archived = new Date('2026-03-10T00:00:00Z');
    expect(deriveNoticeStatus({ ...win, publishedAt: published, archivedAt: archived }, '2026-03-15')).toBe('archived');
    expect(deriveNoticeStatus({ ...win, publishedAt: null, archivedAt: archived }, '2026-03-15')).toBe('archived');
  });

  it('the two boundary days are INCLUSIVE at both ends', () => {
    const n = { ...win, publishedAt: published, archivedAt: null };
    expect(deriveNoticeStatus(n, '2026-02-28')).toBe('scheduled'); // the day before it opens
    expect(deriveNoticeStatus(n, '2026-03-01')).toBe('active'); // its first day counts
    expect(deriveNoticeStatus(n, '2026-03-31')).toBe('active'); // and so does its last
    expect(deriveNoticeStatus(n, '2026-04-01')).toBe('expired'); // the day after it closes
  });

  it('a one-day notice is active on exactly one day', () => {
    const n = { startOn: '2026-05-05', endOn: '2026-05-05', publishedAt: published, archivedAt: null };
    expect(deriveNoticeStatus(n, '2026-05-04')).toBe('scheduled');
    expect(deriveNoticeStatus(n, '2026-05-05')).toBe('active');
    expect(deriveNoticeStatus(n, '2026-05-06')).toBe('expired');
  });
});

// ─────────────────────── the audience snapshot (THE decision) ───────────────────────

describe('6e122302 · THE AUDIENCE IS SNAPSHOT AT PUBLISH', () => {
  it('publishing resolves the criteria once and persists the employment ids', async () => {
    const inFinance = await hire('Finance One');
    const inOps = await hire('Ops One', { deptId: b.deptB });
    const { id } = await draft({ criteria: { departmentIds: [b.deptA] } });

    // A draft has NO audience — that is the whole point of resolving at publish.
    expect(await recipientsOf(id)).toEqual([]);

    const res = await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect(res.recipients).toBe(1);
    expect(await recipientsOf(id)).toEqual([inFinance]);
    expect(await recipientsOf(id)).not.toContain(inOps);
  });

  it('A TRANSFER AFTER PUBLICATION DOES NOT CHANGE WHO THE NOTICE REACHED', async () => {
    // THE spec of this module. Re-resolving the criteria on read would silently drop this employee from
    // a notice they had already been sent — and, once acknowledgement ships, would rewrite the
    // acknowledgement report retrospectively. That is what snapshotting exists to prevent.
    const mover = await hire('Transfers Away');
    const { id } = await draft({ criteria: { departmentIds: [b.deptA] } });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect(await recipientsOf(id)).toEqual([mover]);

    // Move them to the other department, exactly as a real transfer would: close the current assignment
    // and open a new one.
    await owner.db
      .update(schema.assignment)
      .set({ validTo: '2026-06-30' })
      .where(and(eq(schema.assignment.employmentId, mover), eq(schema.assignment.departmentId, b.deptA)));
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: mover,
      departmentId: b.deptB,
      employmentType: 'full_time',
      validFrom: '2026-07-01',
    });

    // The criteria would now resolve to NOBODY…
    const wouldResolveNow = await withTenant(adminCtx(b), (tx) =>
      resolveOrgCriteriaTargets(tx, { criteria: { departmentIds: [b.deptA] }, asOf: '2026-07-15' }),
    );
    expect(wouldResolveNow).not.toContain(mover);
    // …and the notice's audience is unchanged, because it was decided at publish.
    expect(await recipientsOf(id)).toEqual([mover]);
    const still = await noticesForEmployment(adminCtx(b), mover, { today: '2026-07-15' });
    expect(still.map((n) => n.id)).toContain(id);
  });

  it('publishing twice is refused rather than re-snapshotting', async () => {
    await hire('Someone');
    const { id } = await draft();
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    await expect(publishNotice(adminCtx(b), id)).rejects.toBeInstanceOf(NoticeError);
    await expect(publishNotice(adminCtx(b), id)).rejects.toThrow(/already been published/);
  });

  it('a notice that would reach nobody is refused — a broadcast to zero people is a mistake, not a no-op', async () => {
    await hire('Only In Finance');
    const { id } = await draft({ criteria: { departmentIds: [b.deptB] } });
    await expect(publishNotice(adminCtx(b), id, { asOf: '2026-06-01' })).rejects.toThrow(/reach nobody/);
    expect(await recipientsOf(id)).toEqual([]);
  });

  it('EMPTY CRITERIA MEAN EVERYONE — the accident the reach box exists to prevent', async () => {
    const a = await hire('A');
    const c = await hire('C', { deptId: b.deptB });
    const { id } = await draft({ criteria: {} });
    expect(isUnrestrictedOrgCriteria({})).toBe(true);
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect(await recipientsOf(id)).toEqual([a, c].sort());
  });

  it('individual targeting takes the listed ids verbatim', async () => {
    const one = await hire('One');
    await hire('Two');
    const { id } = await draft({ targetMode: 'individual', employmentIds: [one] });
    const res = await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect(res.recipients).toBe(1);
    expect(await recipientsOf(id)).toEqual([one]);
  });

  it('editing a PUBLISHED notice changes its words, never its audience', async () => {
    const finance = await hire('Finance');
    await hire('Ops', { deptId: b.deptB });
    const { id } = await draft({ criteria: { departmentIds: [b.deptA] } });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });

    await updateNotice(adminCtx(b), id, {
      title: 'Annual Leave Policy (corrected)',
      body: 'Corrected text.',
      startOn: '2026-01-01',
      endOn: '2026-12-31',
      // A re-target attempt: the whole other department.
      targetMode: 'criteria',
      criteria: { departmentIds: [b.deptB] },
    });

    const after = await getNotice(adminCtx(b), id);
    expect(after?.title).toBe('Annual Leave Policy (corrected)');
    // The stored criteria are the ORIGINAL ones — the disclosure must keep describing the audience that
    // actually exists, not one that was never resolved.
    expect(after?.criteria.departmentIds).toEqual([b.deptA]);
    expect(await recipientsOf(id)).toEqual([finance]);
  });
});

// ─────────────────────────── lifecycle ───────────────────────────

describe('6e122302 · lifecycle: archive withdraws, delete is for drafts only', () => {
  it('a PUBLISHED notice cannot be deleted — the record of what was announced must survive', async () => {
    await hire('Anyone');
    const { id } = await draft();
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    await expect(deleteNotice(adminCtx(b), id)).rejects.toThrow(/archive it instead/);
    expect(await getNotice(adminCtx(b), id)).not.toBeNull();
  });

  it('a draft can be deleted, and takes nothing with it', async () => {
    const { id } = await draft();
    await deleteNotice(adminCtx(b), id);
    expect(await getNotice(adminCtx(b), id)).toBeNull();
  });

  it('archiving hides a live notice from its recipients immediately; restoring brings it back', async () => {
    const who = await hire('Reader');
    const { id } = await draft({ startOn: '2026-01-01', endOn: '2026-12-31' });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect((await noticesForEmployment(adminCtx(b), who, { today: '2026-06-01' })).length).toBe(1);

    await archiveNotice(adminCtx(b), id);
    expect((await noticesForEmployment(adminCtx(b), who, { today: '2026-06-01' })).length).toBe(0);
    expect((await getNotice(adminCtx(b), id))?.status).toBe('archived');
  });

  it('duplicating produces a DRAFT — a copy that arrived pre-published would broadcast on a click', async () => {
    await hire('Anyone');
    const { id } = await draft({ criteria: { departmentIds: [b.deptA] } });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    const copy = await duplicateNotice(adminCtx(b), id);
    const row = await getNotice(adminCtx(b), copy.id);
    expect(row?.status).toBe('draft');
    expect(row?.publishedAt).toBeNull();
    expect(await recipientsOf(copy.id)).toEqual([]);
    // …and it carries the targeting forward so the copy is a starting point rather than a blank form.
    expect(row?.criteria.departmentIds).toEqual([b.deptA]);
  });

  it('publishing without a named actor is refused IN WORDS, not by a constraint violation', async () => {
    // FOUND BY THE RENDER CHECK, not by reasoning: publishing from a script whose context had no userId
    // came back as `notice_publish_pair_check` — a raw Postgres error naming an internal constraint. The
    // constraint is right (an announcement with no named publisher is not a record of anything, and
    // "Published by" is a column the reporter asked for); what was wrong was reaching it. This is the
    // shape a future "publish scheduled notices" sweep would have, so it is pinned now rather than
    // discovered then.
    await hire('Anyone');
    const { id } = await draft();
    const systemCtx = { ...adminCtx(b), userId: undefined };
    await expect(publishNotice(systemCtx, id)).rejects.toBeInstanceOf(NoticeError);
    await expect(publishNotice(systemCtx, id)).rejects.toThrow(/signed-in administrator/);
    // …and it left no half-published state behind.
    expect((await getNotice(adminCtx(b), id))?.status).toBe('draft');
    expect(await recipientsOf(id)).toEqual([]);
  });

  it('archiving without a named actor is refused the same way', async () => {
    await hire('Anyone');
    const { id } = await draft();
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    await expect(archiveNotice({ ...adminCtx(b), userId: undefined }, id)).rejects.toThrow(/signed-in administrator/);
    expect((await getNotice(adminCtx(b), id))?.archivedAt).toBeNull();
  });

  it('a blank title is refused by the service, not only by the form', async () => {
    await expect(draft({ title: '   ' })).rejects.toThrow(/needs a title/);
  });

  it('an inverted window is refused', async () => {
    await expect(draft({ startOn: '2026-05-10', endOn: '2026-05-01' })).rejects.toThrow(/cannot be before/);
  });
});

// ─────────────────────── employee reads: window, unread, popup ───────────────────────

describe('6e122302 · what an employee sees, and when', () => {
  it('a notice is invisible before its start date and after its end date', async () => {
    const who = await hire('Reader');
    const { id } = await draft({ startOn: '2026-03-01', endOn: '2026-03-31' });
    await publishNotice(adminCtx(b), id, { asOf: '2026-02-01' });
    const on = async (today: string) => (await noticesForEmployment(adminCtx(b), who, { today })).length;
    expect(await on('2026-02-28')).toBe(0);
    expect(await on('2026-03-01')).toBe(1);
    expect(await on('2026-03-31')).toBe(1);
    expect(await on('2026-04-01')).toBe(0);
  });

  it('a DRAFT is invisible to the people its criteria would select', async () => {
    const who = await hire('Reader');
    const { id } = await draft();
    expect(id).toBeTruthy();
    expect((await noticesForEmployment(adminCtx(b), who, { today: '2026-06-01' })).length).toBe(0);
  });

  it('unread counts notices never opened — a view marker, not an acknowledgement', () => {
    const rows = [
      { firstViewedAt: null },
      { firstViewedAt: new Date() },
      { firstViewedAt: null },
    ] as EmployeeNoticeRow[];
    expect(unreadNoticeCount(rows)).toBe(2);
    expect(unreadNoticeCount([])).toBe(0);
  });
});

describe('6e122302 · the popup frequency rule', () => {
  const row = (over: Partial<EmployeeNoticeRow>): EmployeeNoticeRow =>
    ({
      id: 'n1',
      title: 'T',
      body: 'B',
      startOn: '2026-01-01',
      endOn: '2026-12-31',
      showEndDate: false,
      publishedAt: new Date(),
      publishedBy: null,
      firstViewedAt: null,
      popupDismissedAt: null,
      popupEnabled: true,
      popupFrequency: 'once',
      ...over,
    }) as EmployeeNoticeRow;

  it('a notice with the popup switched OFF never pops up, however new it is', () => {
    expect(popupNoticeFor([row({ popupEnabled: false })])).toBeNull();
  });

  it("'once' stops after it is dismissed — the default, so the product does not become something people resent", () => {
    expect(popupNoticeFor([row({})])?.id).toBe('n1');
    expect(popupNoticeFor([row({ popupDismissedAt: new Date() })])).toBeNull();
  });

  it("'until_acknowledged' keeps coming back after a dismissal, because nothing has been acknowledged", () => {
    // RELEASE ONE HONESTY, pinned as a spec: with no acknowledgement record yet this behaves as "every
    // login until the end date" — which IS the reporter's third option. Release two adds the
    // acknowledgement term to this one predicate, and this expectation is what will change with it.
    const r = row({ popupFrequency: 'until_acknowledged', popupDismissedAt: new Date() });
    expect(popupNoticeFor([r])?.id).toBe('n1');
  });

  it('AT MOST ONE popup — a stack of modals on the first screen of the day is how a channel gets ignored', () => {
    const first = row({ id: 'first' });
    const second = row({ id: 'second' });
    const picked = popupNoticeFor([first, second]);
    expect(picked?.id).toBe('first');
    expect(picked).not.toBeInstanceOf(Array);
  });
});

// ─────────────────── the generalised resolver (the anti-duplication proof) ───────────────────

describe('6e122302 · ONE resolver, two callers', () => {
  it('the notice path and the leave-adjustment path select exactly the same employments', async () => {
    // This is the property the generalisation was for. If someone ever re-copies the resolver into one of
    // the two modules, this spec is what notices it — the types alone would not.
    const finance = await hire('Finance');
    await hire('Ops', { deptId: b.deptB });
    const criteria = { departmentIds: [b.deptA] };

    const viaShared = await withTenant(adminCtx(b), (tx) =>
      resolveOrgCriteriaTargets(tx, { criteria, asOf: '2026-06-01' }),
    );
    const viaLeave = await withTenant(adminCtx(b), (tx) =>
      resolveAdjustmentTargets(tx, { criteria, effectiveOn: '2026-06-01' }),
    );
    expect(viaShared).toEqual([finance]);
    expect(viaLeave).toEqual(viaShared);

    const { id } = await draft({ criteria });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });
    expect(await recipientsOf(id)).toEqual(viaShared);
  });

  it('the shared form reader keeps only the fields the resolver understands, and drops empties', () => {
    const posted: Record<string, string[]> = {
      companyIds: ['c1'],
      departmentIds: [],
      orgDivision: ['Central'],
      bogusField: ['ignored'],
    };
    const out = orgCriteriaFromFields((n) => posted[n] ?? []);
    expect(out).toEqual({ companyIds: ['c1'], orgDivision: ['Central'] });
    expect('bogusField' in out).toBe(false);
    expect('departmentIds' in out).toBe(false);
    expect(isUnrestrictedOrgCriteria(out)).toBe(false);
  });
});

// ─────────────── delivery: the EXISTING notification engine, not a second path ───────────────

describe('6e122302 · publishing delivers through core/notifications, and only when asked', () => {
  it('notify ON: every employment in the snapshot gets ONE notification, deep-linked to the notice', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    const one = await hire('One');
    const two = await hire('Two');
    const { id } = await draft({ notifyOnPublish: true });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });

    const res = await dispatchNotifications(adminCtx(b), {});
    expect(res.created).toBe(2);

    const rows = await owner.db
      .select({
        r: schema.notification.recipientEmploymentId,
        kind: schema.notification.kind,
        link: schema.notification.linkPath,
        severity: schema.notification.severity,
      })
      .from(schema.notification);
    expect(rows.map((r) => r.r).sort()).toEqual([one, two].sort());
    expect(rows[0].kind).toBe('notice.published');
    expect(rows[0].link).toBe(`/notices/${id}`);
    // 'info', not 'action': release one has no acknowledgement, so there is nothing the employee must DO,
    // and 'action' would put it in the bell's Task tab as a to-do that can never be cleared.
    expect(rows[0].severity).toBe('info');
  });

  it('notify OFF: publishing still records the event, and NOBODY is notified', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    await hire('One');
    const { id } = await draft({ notifyOnPublish: false });
    await publishNotice(adminCtx(b), id, { asOf: '2026-06-01' });

    const res = await dispatchNotifications(adminCtx(b), {});
    expect(res.created).toBe(0);
    expect(await owner.db.select().from(schema.notification)).toEqual([]);
    // The event is still there — the audit trail records what was published regardless of delivery.
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    expect(events.map((e) => e.t)).toContain('notice.published');
  });
});

// ─────────────────────────── the admin listing ───────────────────────────

describe('6e122302 · the admin listing', () => {
  it('carries the derived status and the snapshot size per row', async () => {
    await hire('One');
    const { id: pub } = await draft({ title: 'Published one' });
    await publishNotice(adminCtx(b), pub, { asOf: '2026-06-01' });
    await draft({ title: 'Draft one' });

    const rows = await listNotices(adminCtx(b), { includeArchived: true });
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('Draft one')?.status).toBe('draft');
    expect(byTitle.get('Draft one')?.recipientCount).toBe(0);
    expect(byTitle.get('Published one')?.recipientCount).toBe(1);
  });

  it('hides archived notices unless asked for them', async () => {
    const { id } = await draft({ title: 'Gone' });
    await archiveNotice(adminCtx(b), id);
    expect((await listNotices(adminCtx(b))).map((r) => r.title)).not.toContain('Gone');
    expect((await listNotices(adminCtx(b), { includeArchived: true })).map((r) => r.title)).toContain('Gone');
  });
});

// ─────────────────── i18n keys check C structurally cannot see ───────────────────

describe('6e122302 · the i18n keys the coverage guard cannot reach', () => {
  /** Resolve a dotted key against en.json — the same walk test/i18n-coverage.test.ts uses. */
  const at = (dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  it('every derived status has a label — the listing renders t(`status.${x}`), a COMPUTED key', () => {
    // Check C matches literal keys only, so `t(`status.${n.status}`)` is invisible to it. Enumerating the
    // closed set here is the documented mitigation for exactly this class.
    for (const s of NOTICE_STATUSES) {
      expect(typeof at(`notices.status.${s}`), `notices.status.${s} is missing from messages/en.json`).toBe('string');
    }
    expect(Object.keys(at('notices.status') as object).sort()).toEqual([...NOTICE_STATUSES].sort());
  });

  it('every criteria-vocabulary label resolves — the file that renders them opens THREE namespaces, so check C skips it entirely', () => {
    // app/admin/notice-board/criteria-options.ts reads `admin.profileOptions.category.<labelKey>` and
    // `people.wizard.employmentType.<value>`. Both label sets already ship; this proves the eight axes and
    // four types this module actually asks for are among them. r127 shipped this exact screen shape with
    // both sets missing, behind a green suite, a green build and a 200.
    for (const c of ORG_ASSIGNMENT_CRITERIA) {
      const key = `admin.profileOptions.category.${c.labelKey}`;
      expect(typeof at(key), `${key} is missing`).toBe('string');
    }
    for (const v of EMPLOYMENT_TYPE_VALUES) {
      const key = `people.wizard.employmentType.${v}`;
      expect(typeof at(key), `${key} is missing`).toBe('string');
    }
  });

  it('the nav label exists (function-access + sidebar both resolve nav.noticeBoard dynamically)', () => {
    expect(typeof at('nav.noticeBoard')).toBe('string');
  });
});
