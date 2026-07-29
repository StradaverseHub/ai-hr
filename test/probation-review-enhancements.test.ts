/**
 * 6522d26a — Probation Management enhancements.
 *
 * Phase 1 (Fn 2): configurable reminder cadence — resolveReminderDays; setHiringDefaults round-trip
 * (validate/sort/dedupe); sweepReviewReminders fires once per (review, offset), is idempotent across
 * re-runs, coalesces catch-up offsets to ONE nudge, respects a custom cadence, skips completed reviews
 * and leavers; SYSTEM actor + summary event; notification fan-out to manager + HR.
 *
 * Phase 2 (Fn 5/6): uploadReviewDocument (admin-only, completed-only, mime/size gate, single
 * system_letter, event with the real user actor); RLS (subject reads own, peer cannot, subject cannot
 * write); ESS visibility via reviewDocumentsFor/getReviewDocument; the HR "issue letter" notification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  decideReview,
  getReviewDocument,
  resolveReminderDays,
  reviewDocumentsFor,
  startReview,
  submitManagerEvaluation,
  subtractDays,
  sweepReviewReminders,
  uploadReviewDocument,
  ReviewError,
} from '../core/employment-review';
import { setHiringDefaults } from '../core/hiring-defaults';
import { dispatchNotifications } from '../core/notifications';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;

const sweepCtx = () => ({ tenantId: b.tenantId, roles: ['hr_admin'] });

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

/** Open a probation review with endDate (owner-set) — the reminder sweep's unit of work. */
async function openReview(employmentId: string, endDate: string) {
  await owner.db.update(schema.employment).set({ probationEndDate: endDate }).where(eq(schema.employment.id, employmentId));
  const { reviewId } = await startReview(adminCtx(b), { employmentId });
  return reviewId;
}

async function completeReview(reviewId: string) {
  const a = adminCtx(b);
  await submitManagerEvaluation(a, { reviewId, recommendation: 'recommend_confirm' });
  await decideReview(a, { reviewId, decision: 'confirm' });
}

const reminderRows = (reviewId: string) =>
  owner.db.select().from(schema.employmentReviewReminder).where(eq(schema.employmentReviewReminder.reviewId, reviewId));
const reminderEvents = (reviewId: string) =>
  owner.db
    .select()
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, reviewId), eq(schema.domainEvent.eventType, 'employment-review.reminder-due')));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('resolveReminderDays + subtractDays (pure)', () => {
  it('null/empty → default [30,14,7]; sanitizes, dedupes, sorts desc; all-invalid → default', () => {
    expect(resolveReminderDays(null)).toEqual([30, 14, 7]);
    expect(resolveReminderDays([])).toEqual([30, 14, 7]);
    expect(resolveReminderDays([7, 30, 14])).toEqual([30, 14, 7]);
    expect(resolveReminderDays([14, 14, 3.9, 400, -2, 0])).toEqual([14, 3]);
    expect(resolveReminderDays([-1, 999])).toEqual([30, 14, 7]);
  });
  it('subtractDays crosses month/year boundaries without TZ drift', () => {
    expect(subtractDays('2026-04-30', 30)).toBe('2026-03-31');
    expect(subtractDays('2026-01-05', 7)).toBe('2025-12-29');
  });
});

// r79a (4fb8b75a step 3): the cadence lives on `company`, not company_payroll_config — it is an
// employment-review setting and never had a payroll reader.
describe('reminder cadence config (company.review_reminder_days)', () => {
  it('round-trips comma-separated input: validates, dedupes, sorts desc; blank → null', async () => {
    const a = adminCtx(b);
    await setHiringDefaults(a, { companyId: b.companyId, reviewReminderDays: '7, 30,14, 14, 400, -3' });
    const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co.reviewReminderDays).toEqual([30, 14, 7]);

    await setHiringDefaults(a, { companyId: b.companyId, reviewReminderDays: '' });
    const [co2] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co2.reviewReminderDays).toBeNull();
  });
});

describe('sweepReviewReminders', () => {
  it('fires once per (review, offset window) at the default cadence and is idempotent per offset', async () => {
    const E = await hire('Cadence');
    const reviewId = await openReview(E.employmentId, '2026-04-30');

    // Before any window: 30-day window opens 2026-03-31.
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-03-30' })).reminders).toBe(0);

    // 30-day window.
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' })).reminders).toBe(1);
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' })).reminders).toBe(0); // idempotent
    let evs = await reminderEvents(reviewId);
    expect(evs).toHaveLength(1);
    expect((evs[0].payload as { offsetDays: number }).offsetDays).toBe(30);

    // 14-day window (opens 2026-04-16), then 7-day (2026-04-23).
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-16' })).reminders).toBe(1);
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-24' })).reminders).toBe(1);
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-25' })).reminders).toBe(0); // all spent
    evs = await reminderEvents(reviewId);
    expect(evs.map((e) => (e.payload as { offsetDays: number }).offsetDays).sort((x, y) => x - y)).toEqual([7, 14, 30]);
    expect(await reminderRows(reviewId)).toHaveLength(3);
  });

  it('coalesces a catch-up (several offsets in-window at once) into ONE nudge + dedup rows for all', async () => {
    const E = await hire('CatchUp');
    const reviewId = await openReview(E.employmentId, '2026-04-30');

    // First-ever sweep 5 days before the end date: 30/14/7 are ALL in-window.
    const r = await sweepReviewReminders(sweepCtx(), { today: '2026-04-25' });
    expect(r.reminders).toBe(1);
    const evs = await reminderEvents(reviewId);
    expect(evs).toHaveLength(1);
    expect((evs[0].payload as { offsetDays: number }).offsetDays).toBe(7); // most urgent
    expect(await reminderRows(reviewId)).toHaveLength(3); // all three offsets marked spent
    // And the re-run is a no-op.
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-26' })).reminders).toBe(0);
  });

  it('respects a custom per-company cadence ([14] only)', async () => {
    await setHiringDefaults(adminCtx(b), { companyId: b.companyId, reviewReminderDays: '14' });
    const E = await hire('Custom');
    const reviewId = await openReview(E.employmentId, '2026-04-30');

    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' })).reminders).toBe(0); // 30 not configured
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-16' })).reminders).toBe(1);
    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-24' })).reminders).toBe(0); // 7 not configured
    const evs = await reminderEvents(reviewId);
    expect(evs).toHaveLength(1);
    expect((evs[0].payload as { offsetDays: number }).offsetDays).toBe(14);
  });

  it('skips completed reviews and leavers (terminated / open resignation)', async () => {
    const Done = await hire('DoneRev');
    const doneId = await openReview(Done.employmentId, '2026-04-30');
    await completeReview(doneId);

    const Termed = await hire('TermedRem');
    const termedId = await openReview(Termed.employmentId, '2026-04-30');
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-04-10' }).where(eq(schema.employment.id, Termed.employmentId));

    const Resigning = await hire('ResigningRem');
    const resigningId = await openReview(Resigning.employmentId, '2026-04-30');
    await owner.db.insert(schema.resignationRequest).values({
      tenantId: b.tenantId,
      employmentId: Resigning.employmentId,
      personId: Resigning.personId,
      lastWorkingDay: '2026-05-15',
      status: 'pending',
    });

    expect((await sweepReviewReminders(sweepCtx(), { today: '2026-04-25' })).reminders).toBe(0);
    for (const id of [doneId, termedId, resigningId]) expect(await reminderEvents(id)).toHaveLength(0);
  });

  it('records a SYSTEM actor per reminder + one summary event per run that did work', async () => {
    const E = await hire('SysActor');
    const reviewId = await openReview(E.employmentId, '2026-04-30');
    await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' });

    const [ev] = await reminderEvents(reviewId);
    expect(ev.actorType).toBe('system');
    expect(ev.subjectEmploymentId).toBe(E.employmentId);

    const summaries = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employment-review.reminders.swept'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].actorType).toBe('system');
    expect((summaries[0].payload as { reminders: number }).reminders).toBe(1);

    // A no-work re-run appends NO extra summary.
    await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' });
    expect(
      await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'employment-review.reminders.swept')),
    ).toHaveLength(1);
  });

  it('notifies the assigned manager + HR admins (kind review.reminder)', async () => {
    // ADR-0077 slice 3: `notifications` is a per-tenant MODULE ROW now, not NOTIFICATIONS_ENABLED —
    // application code no longer reads the env var at all, so writing it here would gate nothing.
    //
    // Both halves of the replacement matter. seedBase's parity set is narrowed by the LIVE env
    // (`legacyEnabledModulesIn(process.env)`), so whether this tenant carries a notifications row would
    // otherwise depend on whether the machine running the suite happens to have NOTIFICATIONS_ENABLED in
    // .env.local. And `adminCtx` derives its snapshot from that SAME env, so wherever no row was seeded
    // it reports the module OFF, `dispatchNotifications` returns early, and the three assertions below
    // pass VACUOUSLY — with zero notification rows, `recipients` is empty, so the negative assertion is
    // satisfied for the wrong reason and the two positives would (correctly) fail only by luck of the
    // machine. The setModule + entitledCtx pair takes the environment out of the question entirely: the
    // ROW is what opens the gate. entitledCtx is a point-in-time read, so it is built AFTER the grant.
    //
    // No try/finally: resetDb() truncates tenant_module between tests, so there is nothing to restore.
    await setModule(b.tenantId, 'notifications', 'active');
    const a = await entitledCtx(b);
    const HR = await hire('HrRem');
    await createAppUser(b.tenantId, HR.personId, 'hr_admin');
    const M = await hire('MgrRem');
    const E = await hire('SubjRem');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    await openReview(E.employmentId, '2026-04-30');
    await dispatchNotifications(a); // drain the .started event first

    await sweepReviewReminders(sweepCtx(), { today: '2026-04-01' });
    await dispatchNotifications(a);
    const notifs = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'review.reminder'));
    const recipients = new Set(notifs.map((n) => n.recipientEmploymentId));
    expect(recipients.has(M.employmentId)).toBe(true);
    expect(recipients.has(HR.employmentId)).toBe(true);
    expect(recipients.has(E.employmentId)).toBe(false); // the subject is not nagged
  });
});

describe('uploadReviewDocument', () => {
  it('is admin-only, completed-only, validates mime/size, and appends the event with the real user actor', async () => {
    const a = adminCtx(b);
    const E = await hire('DocSubj');
    const reviewId = await openReview(E.employmentId, '2026-04-30');

    const uE = await createAppUser(b.tenantId, E.personId, 'employee');
    const subjCtx: SessionContext = { tenantId: b.tenantId, userId: uE, personId: E.personId, roles: ['employee'] };

    // Not completed yet → rejected even for the admin.
    await expect(
      uploadReviewDocument(a, { reviewId, kind: 'signed_letter', fileName: 's.pdf', mimeType: 'application/pdf', content: PDF }),
    ).rejects.toThrow(/completed/i);

    await completeReview(reviewId);

    // Non-admin (the subject) → rejected by the service guard.
    await expect(
      uploadReviewDocument(subjCtx, { reviewId, kind: 'signed_letter', fileName: 's.pdf', mimeType: 'application/pdf', content: PDF }),
    ).rejects.toThrow(ReviewError);

    // Bad mime / empty / oversized → rejected.
    await expect(
      uploadReviewDocument(a, { reviewId, kind: 'signed_letter', fileName: 'x.exe', mimeType: 'application/octet-stream', content: PDF }),
    ).rejects.toThrow(/PDF, JPG, or PNG/i);
    await expect(
      uploadReviewDocument(a, { reviewId, kind: 'signed_letter', fileName: 'e.pdf', mimeType: 'application/pdf', content: Buffer.alloc(0) }),
    ).rejects.toThrow(/empty/i);
    await expect(
      uploadReviewDocument(a, {
        reviewId,
        kind: 'signed_letter',
        fileName: 'big.pdf',
        mimeType: 'application/pdf',
        content: Buffer.alloc(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/10 MB/i);

    // Success: row + event with the real user actor and the subject scoping.
    const { id } = await uploadReviewDocument(a, {
      reviewId,
      kind: 'signed_letter',
      fileName: 'signed.pdf',
      mimeType: 'application/pdf',
      content: PDF,
    });
    const [row] = await owner.db.select().from(schema.reviewDocument).where(eq(schema.reviewDocument.id, id));
    expect(row.employmentId).toBe(E.employmentId); // denormalized for RLS
    expect(row.sizeBytes).toBe(PDF.byteLength);
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, reviewId), eq(schema.domainEvent.eventType, 'employment-review.document-uploaded')));
    expect(ev.actorType).toBe('user');
    expect(ev.actorId).toBe(b.adminUserId);
    expect(ev.subjectEmploymentId).toBe(E.employmentId);
    expect((ev.payload as { kind: string }).kind).toBe('signed_letter');
    // File bytes never land in the payload.
    expect(JSON.stringify(ev.payload)).not.toContain('%PDF');
  });

  it('allows at most ONE system_letter per review; several signed letters are fine', async () => {
    const a = adminCtx(b);
    const E = await hire('OneLetter');
    const reviewId = await openReview(E.employmentId, '2026-04-30');
    await completeReview(reviewId);

    await uploadReviewDocument(a, { reviewId, kind: 'system_letter', fileName: 'l.pdf', mimeType: 'application/pdf', content: PDF });
    await expect(
      uploadReviewDocument(a, { reviewId, kind: 'system_letter', fileName: 'l2.pdf', mimeType: 'application/pdf', content: PDF }),
    ).rejects.toThrow(/already saved/i);
    await uploadReviewDocument(a, { reviewId, kind: 'signed_letter', fileName: 's1.pdf', mimeType: 'application/pdf', content: PDF });
    await uploadReviewDocument(a, { reviewId, kind: 'signed_letter', fileName: 's2.pdf', mimeType: 'application/pdf', content: PDF });
    expect(await owner.db.select().from(schema.reviewDocument).where(eq(schema.reviewDocument.reviewId, reviewId))).toHaveLength(3);
  });
});

describe('review_document RLS + ESS visibility', () => {
  it('subject reads + downloads their own letter; a peer cannot; the subject cannot WRITE', async () => {
    const a = adminCtx(b);
    const E = await hire('EssOwner');
    const X = await hire('EssPeer');
    const reviewId = await openReview(E.employmentId, '2026-04-30');
    await completeReview(reviewId);
    const { id: docId } = await uploadReviewDocument(a, {
      reviewId,
      kind: 'signed_letter',
      fileName: 'signed.pdf',
      mimeType: 'application/pdf',
      content: PDF,
    });

    const uE = await createAppUser(b.tenantId, E.personId, 'employee');
    const uX = await createAppUser(b.tenantId, X.personId, 'employee');
    const subjCtx: SessionContext = { tenantId: b.tenantId, userId: uE, personId: E.personId, roles: ['employee'] };
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uX, personId: X.personId, roles: ['employee'] };

    // ESS list + download for the subject (Fn 6).
    const mine = await reviewDocumentsFor(subjCtx, E.employmentId);
    expect(mine).toHaveLength(1);
    expect(mine[0].fileName).toBe('signed.pdf');
    const dl = await getReviewDocument(subjCtx, docId);
    expect(dl).not.toBeNull();
    expect(Buffer.from(dl!.content).toString('utf8')).toContain('%PDF');

    // Peer: list is empty, download resolves null (→ the route 404s).
    expect(await reviewDocumentsFor(peerCtx, E.employmentId)).toHaveLength(0);
    expect(await getReviewDocument(peerCtx, docId)).toBeNull();

    // Admin sees it.
    expect(await getReviewDocument(a, docId)).not.toBeNull();

    // The subject cannot WRITE a document row (RLS WITH CHECK is is_admin-only) — even a raw insert
    // bypassing the service guard is rejected by the database (drizzle wraps the RLS violation, so
    // assert the rejection + that no row landed rather than matching the wrapped message).
    await expect(
      withTenant(subjCtx, (tx) =>
        tx.insert(schema.reviewDocument).values({
          tenantId: b.tenantId,
          reviewId,
          employmentId: E.employmentId,
          kind: 'signed_letter',
          content: PDF,
          fileName: 'forged.pdf',
          mimeType: 'application/pdf',
          sizeBytes: PDF.byteLength,
        }),
      ),
    ).rejects.toThrow();
    const all = await owner.db.select().from(schema.reviewDocument).where(eq(schema.reviewDocument.reviewId, reviewId));
    expect(all).toHaveLength(1); // still only the admin's upload — the forged row never landed
  });
});

describe('issue-letter follow-up task (Fn 5.2)', () => {
  it('a decided review fans out "review.issue-letter" to HR admins, deep-linked to the profile', async () => {
    // ADR-0077 slice 3 — same conversion as the reminder fan-out above: grant the `notifications` module
    // ROW, then resolve the session from it with `entitledCtx`. `adminCtx`'s snapshot comes from
    // `legacyEnabledModulesIn(process.env)` and would leave dispatch a no-op on any machine without
    // NOTIFICATIONS_ENABLED, which would make `not.toContain(E.employmentId)` true against an EMPTY
    // table (and blow up on `issue[0]` only by accident). The row is what proves the fan-out.
    await setModule(b.tenantId, 'notifications', 'active');
    const a = await entitledCtx(b);
    const HR = await hire('HrIssue');
    await createAppUser(b.tenantId, HR.personId, 'hr_admin');
    const E = await hire('SubjIssue');
    const reviewId = await openReview(E.employmentId, '2026-04-30');
    await completeReview(reviewId);
    await dispatchNotifications(a);

    const issue = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'review.issue-letter'));
    expect(issue.map((n) => n.recipientEmploymentId)).toContain(HR.employmentId);
    expect(issue.map((n) => n.recipientEmploymentId)).not.toContain(E.employmentId);
    expect(issue[0].linkPath).toBe(`/admin/personnel/${E.employmentId}`);

    // The subject still gets the plain "complete" notification.
    const decided = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'review.decided'));
    expect(decided.map((n) => n.recipientEmploymentId)).toContain(E.employmentId);
  });
});
