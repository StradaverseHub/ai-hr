/**
 * 6e122302 — the Notice Board. HR publishes an announcement to a resolved set of employees.
 *
 * RELEASE ONE OF TWO. This module carries creating, targeting, publishing, archiving and the employee-side
 * reads (dashboard card, listing, reading page, login popup). ACKNOWLEDGEMENT TRACKING IS NOT HERE and is
 * not half-here: there is no acknowledgement row, no agreement text, no "require acknowledgement" flag and
 * no HR acknowledgement report. The approved plan splits the item that way on purpose — publishing is
 * useful on day one, and acknowledgement is EVIDENCE, which is worth getting right rather than fast.
 *
 * ── THREE DECISIONS, ALL LOAD-BEARING ─────────────────────────────────────────────────────────────────
 *
 * 1. THE AUDIENCE IS SNAPSHOT AT PUBLISH TIME (`publishNotice` → `notice_recipient`).
 *    Re-resolving the criteria on each read is less schema and it is wrong: an employee who transfers
 *    department after publication would silently stop being a recipient of a notice they had already been
 *    sent, and (release two) an acknowledgement report would change retrospectively. The criteria are kept
 *    on the notice for disclosure — "who was this aimed at" — and the snapshot is who it reached.
 *
 * 2. STATUS IS DERIVED, NEVER STORED (`deriveNoticeStatus`). Draft / Scheduled / Active / Expired fall out
 *    of (publishedAt, startOn, endOn); Archived is archivedAt. A status column would need a nightly job to
 *    flip it and would acquire a way to be wrong.
 *
 * 3. DELIVERY GOES THROUGH THE EXISTING NOTIFICATION ENGINE. Publishing appends a `notice.published`
 *    domain event; core/notifications.ts has a REGISTRY entry that fans it out to the snapshot audience.
 *    There is no second mail path here, and no mail code at all.
 *
 * The targeting engine is `core/org-criteria.ts`, shared with bulk leave adjustments rather than copied.
 */
import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, gte, sql } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, notice, noticeRecipient } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  isUnrestrictedOrgCriteria,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from './org-criteria';

export class NoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoticeError';
  }
}

/** Popup behaviour. 'once' = once per notice per employee; 'until_acknowledged' = while the notice is live. */
export const NOTICE_POPUP_FREQUENCIES = ['once', 'until_acknowledged'] as const;
export type NoticePopupFrequency = (typeof NOTICE_POPUP_FREQUENCIES)[number];

export const NOTICE_TARGET_MODES = ['criteria', 'individual'] as const;
export type NoticeTargetMode = (typeof NOTICE_TARGET_MODES)[number];

/**
 * The five states a notice can be in. Ordered by how they are decided, which is also the order
 * `deriveNoticeStatus` tests them — `archived` wins over everything, because an archived notice is
 * withdrawn regardless of what its dates say.
 */
export const NOTICE_STATUSES = ['archived', 'draft', 'scheduled', 'active', 'expired'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/**
 * THE single definition of a notice's status. Pure: it takes the three facts and today's date, so the
 * listing, the employee reads and the tests all agree by construction rather than by discipline.
 *
 * `today` MUST be a tenant-local ISO date (`todayInKualaLumpur()`), never `new Date().toISOString()` —
 * between 00:00 and 08:00 MYT the UTC date is yesterday, which would report a notice starting today as
 * still `scheduled` for the first eight hours of its life.
 */
export function deriveNoticeStatus(
  n: { publishedAt: Date | null; archivedAt: Date | null; startOn: string; endOn: string },
  today: string,
): NoticeStatus {
  if (n.archivedAt) return 'archived';
  if (!n.publishedAt) return 'draft';
  // ISO YYYY-MM-DD strings compare lexically, so plain string comparison is correct date ordering.
  if (today < n.startOn) return 'scheduled';
  if (today > n.endOn) return 'expired';
  return 'active';
}

/** A notice is READABLE by its recipients exactly when it is published, unarchived and inside its window. */
export function isNoticeLive(
  n: { publishedAt: Date | null; archivedAt: Date | null; startOn: string; endOn: string },
  today: string,
): boolean {
  return deriveNoticeStatus(n, today) === 'active';
}

export type NoticeInput = {
  title: string;
  body: string;
  startOn: string;
  endOn: string;
  showEndDate?: boolean;
  targetMode?: NoticeTargetMode;
  criteria?: OrgCriteria;
  employmentIds?: string[];
  notifyOnPublish?: boolean;
  popupEnabled?: boolean;
  popupFrequency?: NoticePopupFrequency;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Publishing and archiving both record WHO did it, and the `notice_publish_pair_check` /
 * `notice_archive_pair_check` constraints (migration 0390) refuse a timestamp without an actor.
 *
 * Without this guard an actor-less context — a system/automation session, or a principal resolved without
 * a user id — reaches the database and comes back as a raw constraint violation naming an internal check.
 * Found by publishing from a script during the render verification, which is exactly the shape a future
 * "publish scheduled notices" sweep would have. Refused HERE, in words, because the constraint is right:
 * a company-wide announcement with no named publisher is not a record of anything, and "Published by —"
 * is the column the reporter asked for.
 */
function requireActor(ctx: SessionContext, verb: string): string {
  if (!ctx.userId) {
    throw new NoticeError(`A notice can only be ${verb} by a signed-in administrator — the record has to name who did it.`);
  }
  return ctx.userId;
}

/**
 * Validate and normalise a notice's fields. Module-private and shared by create + update, so an edit can
 * never produce a notice a create would have refused — the asymmetry that lets bad rows in through the
 * back door.
 */
function cleanNotice(p: NoticeInput): Required<Omit<NoticeInput, 'criteria' | 'employmentIds'>> & {
  criteria: OrgCriteria;
  employmentIds: string[];
} {
  const title = (p.title ?? '').trim();
  if (!title) throw new NoticeError('A notice needs a title — it is what people see in the listing.');
  if (title.length > 200) throw new NoticeError('The title is too long (200 characters maximum).');
  const body = (p.body ?? '').trim();
  if (!body) throw new NoticeError('A notice needs content.');
  if (!ISO_DATE.test(p.startOn ?? '')) throw new NoticeError('A valid start date is required.');
  if (!ISO_DATE.test(p.endOn ?? '')) throw new NoticeError('A valid end date is required.');
  if (p.endOn < p.startOn) throw new NoticeError('The end date cannot be before the start date.');

  const targetMode: NoticeTargetMode = p.targetMode === 'individual' ? 'individual' : 'criteria';
  const employmentIds = Array.from(new Set((p.employmentIds ?? []).filter(Boolean)));
  if (targetMode === 'individual' && employmentIds.length === 0) {
    throw new NoticeError('Choose at least one employee, or target by criteria instead.');
  }
  const popupFrequency: NoticePopupFrequency =
    p.popupFrequency === 'until_acknowledged' ? 'until_acknowledged' : 'once';

  return {
    title,
    body,
    startOn: p.startOn,
    endOn: p.endOn,
    showEndDate: p.showEndDate === true,
    targetMode,
    criteria: targetMode === 'criteria' ? (p.criteria ?? {}) : {},
    employmentIds: targetMode === 'individual' ? employmentIds : [],
    notifyOnPublish: p.notifyOnPublish === true,
    popupEnabled: p.popupEnabled === true,
    popupFrequency,
  };
}

/**
 * `individual` targeting posts employment ids verbatim, so they are stored on the notice's criteria blob
 * under a reserved key rather than in a second column. Keeping ONE place where "who was asked for" lives
 * means the publish path has one thing to read, and the disclosure view has one thing to show.
 */
type StoredCriteria = OrgCriteria & { employmentIds?: string[] };

export async function createNotice(ctx: SessionContext, p: NoticeInput): Promise<{ id: string }> {
  const c = cleanNotice(p);
  return withTenant(ctx, async (tx) => {
    const stored: StoredCriteria =
      c.targetMode === 'individual' ? { employmentIds: c.employmentIds } : c.criteria;
    const [row] = await tx
      .insert(notice)
      .values({
        tenantId: ctx.tenantId,
        title: c.title,
        body: c.body,
        startOn: c.startOn,
        endOn: c.endOn,
        showEndDate: c.showEndDate,
        targetMode: c.targetMode,
        criteria: stored as unknown,
        notifyOnPublish: c.notifyOnPublish,
        popupEnabled: c.popupEnabled,
        popupFrequency: c.popupFrequency,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: notice.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: row.id,
      eventType: 'notice.created',
      actor: actorOf(ctx),
      payload: { title: c.title, startOn: c.startOn, endOn: c.endOn, targetMode: c.targetMode },
    });
    return { id: row.id };
  });
}

/**
 * Edit a notice. A PUBLISHED notice may still be edited (a typo in a live announcement must be fixable),
 * but editing does NOT re-resolve the audience: the snapshot is who was sent it, and silently adding or
 * removing recipients under an announcement people have already read is the retrospective-change failure
 * this whole design exists to avoid. Re-targeting means archiving and publishing a fresh notice.
 */
export async function updateNotice(ctx: SessionContext, id: string, p: NoticeInput): Promise<void> {
  const c = cleanNotice(p);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(notice).where(eq(notice.id, id)).limit(1);
    if (!before) throw new NoticeError('That notice could not be found.');
    if (before.archivedAt) throw new NoticeError('An archived notice cannot be edited — restore it first.');

    const published = before.publishedAt != null;
    const stored: StoredCriteria =
      c.targetMode === 'individual' ? { employmentIds: c.employmentIds } : c.criteria;

    await tx
      .update(notice)
      .set({
        title: c.title,
        body: c.body,
        startOn: c.startOn,
        endOn: c.endOn,
        showEndDate: c.showEndDate,
        // Targeting is frozen once published — see the header note. Silently ignoring a posted change
        // would be worse than refusing it, so the stored values simply stay put and the screen hides the
        // audience step for a published notice.
        targetMode: published ? before.targetMode : c.targetMode,
        criteria: published ? before.criteria : (stored as unknown),
        notifyOnPublish: c.notifyOnPublish,
        popupEnabled: c.popupEnabled,
        popupFrequency: c.popupFrequency,
        updatedAt: sql`now()`,
      })
      .where(eq(notice.id, id));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.updated',
      actor: actorOf(ctx),
      payload: {
        before: { title: before.title, startOn: before.startOn, endOn: before.endOn },
        after: { title: c.title, startOn: c.startOn, endOn: c.endOn },
        targetingFrozen: published,
      },
    });
  });
}

/**
 * PUBLISH — resolve the audience once, persist it, and record what happened.
 *
 * Returns the number of employments the notice reached. Idempotent in the sense that matters: publishing
 * an already-published notice is refused rather than re-snapshotting, because a second snapshot taken a
 * month later would silently change who a live announcement was addressed to.
 */
export async function publishNotice(
  ctx: SessionContext,
  id: string,
  opts: { asOf?: string } = {},
): Promise<{ recipients: number }> {
  const asOf = opts.asOf && ISO_DATE.test(opts.asOf) ? opts.asOf : todayInKualaLumpur();
  const actorUserId = requireActor(ctx, 'published');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(notice).where(eq(notice.id, id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.archivedAt) throw new NoticeError('An archived notice cannot be published.');
    if (row.publishedAt) throw new NoticeError('That notice has already been published.');

    const stored = (row.criteria ?? {}) as StoredCriteria;
    let targets: string[];
    if (row.targetMode === 'individual') {
      targets = Array.from(new Set((stored.employmentIds ?? []).filter(Boolean)));
    } else {
      // ⚠️ The audience is resolved AS AT the publish date, not the notice's start date. A notice
      // scheduled to open next month reaches the people who are here NOW, which is what an administrator
      // pressing Publish today means — and it is the only reading under which the count they were shown
      // before pressing the button is the count they get.
      // Strip the reserved individual-targeting key before handing the object to the resolver: it lives on
      // the same blob (one place for "who was asked for") and is not a criteria axis.
      const criteria: OrgCriteria = { ...stored };
      delete (criteria as StoredCriteria).employmentIds;
      targets = await resolveOrgCriteriaTargets(tx, { criteria, asOf });
    }
    if (targets.length === 0) {
      throw new NoticeError('No employees matched — this notice would reach nobody.');
    }

    // Every target must be one this session can actually see. RLS decides that: an id from another tenant,
    // or one an admin's company scope excludes, simply does not come back and is dropped here rather than
    // being written into a snapshot the reader could never have produced.
    const visible = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(inArray(employment.id, targets));
    const recipientIds = visible.map((v) => v.id);
    if (recipientIds.length === 0) {
      throw new NoticeError('No employees matched — this notice would reach nobody.');
    }

    await tx
      .insert(noticeRecipient)
      .values(
        recipientIds.map((employmentId) => ({
          tenantId: ctx.tenantId,
          noticeId: id,
          employmentId,
        })),
      )
      .onConflictDoNothing();

    await tx
      .update(notice)
      .set({ publishedAt: sql`now()`, publishedByUserId: actorUserId, updatedAt: sql`now()` })
      .where(eq(notice.id, id));

    // The event core/notifications.ts turns into notifications for the snapshot audience. `notify` rides
    // in the payload so the registry can decide WITHOUT a second query, and so switching the flag off
    // after the fact cannot retroactively un-send what was already dispatched.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.published',
      actor: actorOf(ctx),
      payload: {
        title: row.title,
        recipients: recipientIds.length,
        notify: row.notifyOnPublish === true,
        asOf,
      },
    });

    return { recipients: recipientIds.length };
  });
}

/** Withdraw a notice. Archiving is how a published notice is taken down — never by deleting it. */
export async function archiveNotice(ctx: SessionContext, id: string): Promise<void> {
  const actorUserId = requireActor(ctx, 'archived');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select({ archivedAt: notice.archivedAt }).from(notice).where(eq(notice.id, id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.archivedAt) throw new NoticeError('That notice is already archived.');
    await tx
      .update(notice)
      .set({ archivedAt: sql`now()`, archivedByUserId: actorUserId, updatedAt: sql`now()` })
      .where(eq(notice.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.archived',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

export async function restoreNotice(ctx: SessionContext, id: string): Promise<void> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select({ archivedAt: notice.archivedAt }).from(notice).where(eq(notice.id, id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (!row.archivedAt) throw new NoticeError('That notice is not archived.');
    await tx
      .update(notice)
      .set({ archivedAt: null, archivedByUserId: null, updatedAt: sql`now()` })
      .where(eq(notice.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.restored',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

/**
 * Delete — DRAFTS ONLY.
 *
 * A published notice was broadcast to people; deleting it would erase the fact that a company-wide
 * announcement was made, and (release two) the acknowledgements given against it. Archive is the way to
 * withdraw one. A draft has reached nobody, so deleting it loses nothing.
 */
export async function deleteNotice(ctx: SessionContext, id: string): Promise<void> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select({ publishedAt: notice.publishedAt }).from(notice).where(eq(notice.id, id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.publishedAt) {
      throw new NoticeError('A published notice cannot be deleted — archive it instead, so the record of what was announced survives.');
    }
    await tx.delete(notice).where(eq(notice.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

/** Duplicate a notice as a fresh DRAFT — the reporter's "Duplicate" action. Copies content and targeting,
 *  never the publication: a copy that arrived pre-published would broadcast on the click of a button
 *  labelled Duplicate. */
export async function duplicateNotice(ctx: SessionContext, id: string): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(notice).where(eq(notice.id, id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    const [copy] = await tx
      .insert(notice)
      .values({
        tenantId: ctx.tenantId,
        title: `${row.title} (copy)`.slice(0, 200),
        body: row.body,
        startOn: row.startOn,
        endOn: row.endOn,
        showEndDate: row.showEndDate,
        targetMode: row.targetMode,
        criteria: row.criteria,
        notifyOnPublish: row.notifyOnPublish,
        popupEnabled: row.popupEnabled,
        popupFrequency: row.popupFrequency,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: notice.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: copy.id,
      eventType: 'notice.created',
      actor: actorOf(ctx),
      payload: { title: row.title, duplicatedFrom: id },
    });
    return { id: copy.id };
  });
}

// ─────────────────────────────── Admin reads ───────────────────────────────

export type NoticeRow = {
  id: string;
  title: string;
  body: string;
  startOn: string;
  endOn: string;
  showEndDate: boolean;
  targetMode: NoticeTargetMode;
  criteria: OrgCriteria & { employmentIds?: string[] };
  status: NoticeStatus;
  publishedAt: Date | null;
  publishedBy: string | null;
  archivedAt: Date | null;
  notifyOnPublish: boolean;
  popupEnabled: boolean;
  popupFrequency: NoticePopupFrequency;
  recipientCount: number;
  createdAt: Date;
};

/**
 * The admin listing. `status` is derived per row against the tenant-local today, so the screen never has
 * to know the rule and can never disagree with the reads.
 *
 * `publishedBy` resolves through app_user → person for the reporter's "Published By" column. It is NOT
 * filtered for archived logins: showing who published a past announcement is correct even after they
 * leave, and blanking it would erase history (the per-site rule stated in core/notifications.ts — only
 * RECIPIENT resolution filters switched-off logins).
 */
export async function listNotices(
  ctx: SessionContext,
  opts: { includeArchived?: boolean } = {},
): Promise<NoticeRow[]> {
  const today = todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        startOn: notice.startOn,
        endOn: notice.endOn,
        showEndDate: notice.showEndDate,
        targetMode: notice.targetMode,
        criteria: notice.criteria,
        publishedAt: notice.publishedAt,
        archivedAt: notice.archivedAt,
        notifyOnPublish: notice.notifyOnPublish,
        popupEnabled: notice.popupEnabled,
        popupFrequency: notice.popupFrequency,
        createdAt: notice.createdAt,
        // ⚠️ THE OUTER COLUMNS ARE WRITTEN OUT, NOT INTERPOLATED, AND THAT IS NOT A STYLE CHOICE.
        // Drizzle renders `${notice.id}` inside a raw `sql` template as the BARE column name `"id"`, not
        // `"notice"."id"`. In a correlated subquery that binds to the INNER scope: `nr.notice_id = "id"`
        // silently became `nr.notice_id = nr.id`, which is false for every row, so every notice reported
        // ZERO recipients while the rows were sitting there. Nothing errors — it is a valid query that
        // answers a different question. (`"published_by_user_id"` happened to work only because app_user
        // and person have no such column, so Postgres fell back to the outer scope; one column rename away
        // from the same silent wrong.) Fully qualified, both are unambiguous.
        publishedBy: sql<string | null>`(
          select p.full_name from app_user au join person p on p.id = au.person_id
          where au.id = notice.published_by_user_id
        )`,
        recipientCount: sql<number>`(
          select count(*)::int from notice_recipient nr where nr.notice_id = notice.id
        )`,
      })
      .from(notice)
      .where(opts.includeArchived ? undefined : isNull(notice.archivedAt))
      .orderBy(desc(notice.createdAt));
    return rows.map((r) => ({
      ...r,
      targetMode: r.targetMode as NoticeTargetMode,
      popupFrequency: r.popupFrequency as NoticePopupFrequency,
      criteria: (r.criteria ?? {}) as OrgCriteria & { employmentIds?: string[] },
      status: deriveNoticeStatus(r, today),
    }));
  });
}

export async function getNotice(ctx: SessionContext, id: string): Promise<NoticeRow | null> {
  const rows = await listNotices(ctx, { includeArchived: true });
  return rows.find((r) => r.id === id) ?? null;
}

// ───────────────────────────── Employee reads ─────────────────────────────

export type EmployeeNoticeRow = {
  id: string;
  title: string;
  body: string;
  startOn: string;
  endOn: string;
  showEndDate: boolean;
  publishedAt: Date | null;
  publishedBy: string | null;
  firstViewedAt: Date | null;
  popupDismissedAt: Date | null;
  popupEnabled: boolean;
  popupFrequency: NoticePopupFrequency;
};

/**
 * The notices ONE employment may currently see: published, unarchived, inside the window, and in this
 * notice's audience snapshot.
 *
 * ⚠️ THE WINDOW IS TESTED HERE, IN THE TENANT TIMEZONE, and that is deliberate. The RLS policy on `notice`
 * fences the same window one day wider on each side because Postgres `current_date` is UTC and would hide
 * a notice for the first eight hours of its start date in MYT (see migration 0390's note). This read is
 * the authoritative test; RLS is the backstop that stops a forgotten filter leaking next month's
 * announcement.
 */
export async function noticesForEmployment(
  ctx: SessionContext,
  employmentId: string,
  opts: { today?: string } = {},
): Promise<EmployeeNoticeRow[]> {
  const today = opts.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        startOn: notice.startOn,
        endOn: notice.endOn,
        showEndDate: notice.showEndDate,
        publishedAt: notice.publishedAt,
        popupEnabled: notice.popupEnabled,
        popupFrequency: notice.popupFrequency,
        firstViewedAt: noticeRecipient.firstViewedAt,
        popupDismissedAt: noticeRecipient.popupDismissedAt,
        // Fully qualified for the reason spelled out in `listNotices` above: Drizzle renders an
        // interpolated column BARE inside a raw sql template, which a correlated subquery then resolves
        // against its own scope.
        publishedBy: sql<string | null>`(
          select p.full_name from app_user au join person p on p.id = au.person_id
          where au.id = notice.published_by_user_id
        )`,
      })
      .from(noticeRecipient)
      .innerJoin(notice, eq(notice.id, noticeRecipient.noticeId))
      .where(
        and(
          eq(noticeRecipient.employmentId, employmentId),
          isNotNull(notice.publishedAt),
          isNull(notice.archivedAt),
          lte(notice.startOn, today),
          gte(notice.endOn, today),
        ),
      )
      .orderBy(desc(notice.publishedAt), asc(notice.title));
    return rows.map((r) => ({ ...r, popupFrequency: r.popupFrequency as NoticePopupFrequency }));
  });
}

/** How many live notices this employment has never opened — the dashboard card's "(3 New)" badge. */
export function unreadNoticeCount(rows: readonly EmployeeNoticeRow[]): number {
  return rows.filter((r) => r.firstViewedAt == null).length;
}

/**
 * Which live notice, if any, should pop up after login — and there is AT MOST ONE.
 *
 * A queue of modals stacked on someone's first screen of the day is how a communication channel becomes a
 * thing people click through without reading. The most recently published eligible notice wins; the rest
 * are waiting on the dashboard card, which is where a notice board belongs.
 *
 * The frequency rule:
 *   • 'once'                — show until the employee dismisses it, then never again.
 *   • 'until_acknowledged'  — show every time, while the notice is live.
 *
 * ⚠️ RELEASE ONE HONESTY: with no acknowledgement record yet, "until acknowledged" cannot end, so it
 * behaves as "every login until the end date". That is exactly the reporter's third option ("Display every
 * login until the End Date or acknowledgement is completed"), so the behaviour is right today and release
 * two only has to add the acknowledgement term to this one predicate.
 */
export function popupNoticeFor(rows: readonly EmployeeNoticeRow[]): EmployeeNoticeRow | null {
  const due = rows.filter((r) => {
    if (!r.popupEnabled) return false;
    if (r.popupFrequency === 'until_acknowledged') return true;
    return r.popupDismissedAt == null;
  });
  return due[0] ?? null;
}

/**
 * Mark a notice OPENED by this employment. First open only — `first_viewed_at` records when the employee
 * first saw it, and overwriting it on every re-read would destroy that.
 *
 * THIS IS NOT AN ACKNOWLEDGEMENT and must never be presented as one: it is a page load, not consent.
 */
export async function markNoticeViewed(ctx: SessionContext, noticeId: string, employmentId: string): Promise<void> {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(noticeRecipient)
      .set({ firstViewedAt: sql`now()` })
      .where(
        and(
          eq(noticeRecipient.noticeId, noticeId),
          eq(noticeRecipient.employmentId, employmentId),
          isNull(noticeRecipient.firstViewedAt),
        ),
      );
  });
}

/** Dismiss the popup for this (notice, employment). Popup state only — see the header. */
export async function dismissNoticePopup(ctx: SessionContext, noticeId: string, employmentId: string): Promise<void> {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(noticeRecipient)
      .set({ popupDismissedAt: sql`now()` })
      .where(and(eq(noticeRecipient.noticeId, noticeId), eq(noticeRecipient.employmentId, employmentId)));
  });
}

/**
 * How many employees a criteria set would reach right now — the number the setup screen shows BEFORE the
 * publish button is live. Re-exported through this module so the screen has one import, and because the
 * warning that goes with it (an empty criteria object means everyone) belongs to the same thought.
 */
export async function countNoticeAudience(
  ctx: SessionContext,
  p: { criteria: OrgCriteria; asOf?: string },
): Promise<{ count: number; unrestricted: boolean }> {
  const asOf = p.asOf && ISO_DATE.test(p.asOf) ? p.asOf : todayInKualaLumpur();
  const count = await withTenant(ctx, async (tx) =>
    (await resolveOrgCriteriaTargets(tx, { criteria: p.criteria ?? {}, asOf })).length,
  );
  return { count, unrestricted: isUnrestrictedOrgCriteria(p.criteria) };
}
