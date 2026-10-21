/**
 * 6e122302 — the Notice Board. HR publishes an announcement to a resolved set of employees.
 *
 * Published content retains immutable revisions. Viewing, popup dismissal and explicit version-bound
 * acknowledgement are separate facts. The database command commits a receipt with its real actor and
 * audit event atomically; an old page cannot acknowledge newer content.
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
import {createHash} from 'node:crypto';
import {resolveDocumentUpload} from './employee-documents';
import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, gte, sql } from 'drizzle-orm';

import { withTenant, type SessionContext,type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company,employment, notice, noticeRecipient,noticeRevision,noticeAcknowledgement,noticeAttachment } from '../db/schema';
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
  /** Stable authoring boundary. Null/absent requires group-wide administrator authority. */
  companyId?: string | null;
  title: string;
  body: string;
  summary?:string;
  category?:string|null;
  pinned?:boolean;
  requiresAcknowledgement?:boolean;
  attachmentIds?:string[];
  expectedContentVersion?:number;
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
const uuidNotice=(id:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

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
function cleanNotice(p: NoticeInput): Required<Omit<NoticeInput, 'criteria' | 'employmentIds' | 'expectedContentVersion'>> & {
  criteria: OrgCriteria;
  employmentIds: string[];
} {
  const title = (p.title ?? '').trim();
  if(p.companyId!=null&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.companyId))throw new NoticeError('Choose an available authoring company.');
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
  const summary=(p.summary?.trim()||body.replace(/<[^>]*>/g,'').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[#*_`~>]/g,'')).replace(/\s+/g,' ').trim().slice(0,240);
  const category=p.category?.trim()||null;
  if(category&&category.length>80)throw new NoticeError('A notice category must be at most 80 characters.');
  const attachmentIds=p.attachmentIds??[];
  if(attachmentIds.length>5||new Set(attachmentIds).size!==attachmentIds.length||attachmentIds.some(id=>!uuidNotice(id)))throw new NoticeError('Choose at most five available notice attachments.');
  const popupFrequency: NoticePopupFrequency =
    p.popupFrequency === 'until_acknowledged' ? 'until_acknowledged' : 'once';

  return {
    companyId: p.companyId ?? null,
    summary,category,pinned:p.pinned===true,requiresAcknowledgement:p.requiresAcknowledgement===true,attachmentIds,
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

/** Being a recipient does not authorize the administrator editor or its writes. */
const authoringNotice=(id:string)=>and(eq(notice.id,id),sql`app.can_manage_notice(${notice.id})`);
function requireNoticeWrite(rows:readonly {id:string}[]){if(rows.length!==1)throw new NoticeError('That notice is no longer available in your authoring scope.');}

export function noticeAuthoringScope(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  const [group]=await tx.execute(sql`SELECT app.principal_snapshot_current() AND app.is_group_admin() AS allowed`) as unknown as {allowed:boolean}[];
  const companies=await tx.select({id:company.id,name:company.legalName}).from(company)
   .where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() AND app.is_admin_for(${company.id})`))
   .orderBy(asc(company.legalName),asc(company.id));
  return {groupAllowed:group?.allowed===true,companies};
 });
}

/** The preview and publisher use the same audience resolver and authoring boundary. Unresolved tokens
 * stay in the draft; only real, authorized employments count, and an incomplete audience cannot publish.
 * Resolution is as at publication/preview time, never a scheduled notice's future start date. */
async function resolveNoticeAudienceTx(tx:Tx,ctx:SessionContext,row:Pick<typeof notice.$inferSelect,'criteria'|'targetMode'|'ownerCompanyId'>,asOf:string){
 const stored=(row.criteria??{}) as StoredCriteria,criteria:OrgCriteria={...stored};delete (criteria as StoredCriteria).employmentIds;
 let targets:string[],scopeMismatch=false;
 if(row.targetMode==='individual')targets=Array.from(new Set((stored.employmentIds??[]).filter(Boolean).map(value=>/^[0-9a-f-]{36}$/i.test(value)?value.toLowerCase():value)));
 else{
  const companies=await tx.select({id:company.id}).from(company).where(and(eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id})`,
   row.ownerCompanyId?sql`(${company.id}=${row.ownerCompanyId}::uuid OR app.is_company_descendant(${company.id},${row.ownerCompanyId}::uuid))`:undefined));
  const allowed=new Set(companies.map(item=>item.id));
  const requested=(criteria.companyIds??[]).filter(Boolean).map(value=>value.toLowerCase());
  scopeMismatch=requested.some(id=>!allowed.has(id));
  const bounded=requested.length?requested.filter(id=>allowed.has(id)):[...allowed];
  // An empty company restriction means "all" to the shared criteria owner, so do not call it when
  // the authoring intersection is empty. Other dated/active/department rules remain with that owner.
  targets=bounded.length?await resolveOrgCriteriaTargets(tx,{criteria:{...criteria,companyIds:bounded},asOf}):[];
 }
 const valid=targets.filter(target=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target));
 const visible=valid.length?await tx.select({id:employment.id}).from(employment)
  .where(and(inArray(employment.id,valid),eq(employment.tenantId,ctx.tenantId),sql`app.is_admin_for(${employment.companyId})`,
   row.ownerCompanyId?sql`(${employment.companyId}=${row.ownerCompanyId}::uuid OR app.is_company_descendant(${employment.companyId},${row.ownerCompanyId}::uuid))`:undefined))
  .orderBy(asc(employment.id)):[];
 return {ids:visible.map(item=>item.id),invalid:valid.length!==targets.length,incomplete:scopeMismatch||visible.length!==targets.length,
  unrestricted:row.ownerCompanyId===null&&row.targetMode==='criteria'&&isUnrestrictedOrgCriteria(criteria)};
}

export function noticeAudiencePreview(ctx:SessionContext,id:string){
 return withTenant(ctx,async tx=>{
  const [row]=await tx.select().from(notice).where(authoringNotice(id)).limit(1);
  if(!row||row.publishedAt)throw new NoticeError('Choose an available draft notice to preview its audience.');
  const result=await resolveNoticeAudienceTx(tx,ctx,row,todayInKualaLumpur());
  return {count:result.ids.length,incomplete:result.incomplete,unrestricted:result.unrestricted};
 });
}

export async function createNotice(ctx: SessionContext, p: NoticeInput): Promise<{ id: string }> {
  const c = cleanNotice(p);
  return withTenant(ctx, async (tx) => {
    const stored: StoredCriteria =
      c.targetMode === 'individual' ? { employmentIds: c.employmentIds } : c.criteria;
    const [row] = await tx
      .insert(notice)
      .values({
        tenantId: ctx.tenantId,
        ownerCompanyId: c.companyId,
        title: c.title,
        body: c.body,
        summary:c.summary,category:c.category,pinned:c.pinned,requiresAcknowledgement:c.requiresAcknowledgement,attachmentIds:c.attachmentIds,
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
    const [before] = await tx.select().from(notice).where(authoringNotice(id)).limit(1).for('update');
    if (!before) throw new NoticeError('That notice could not be found.');
    if (before.archivedAt) throw new NoticeError('An archived notice cannot be edited — restore it first.');
    if(p.expectedContentVersion!==undefined&&p.expectedContentVersion!==before.contentVersion)throw new NoticeError('Notice content changed; reload before saving.');
    if(p.companyId!==undefined&&c.companyId!==before.ownerCompanyId)throw new NoticeError('The authoring company is fixed. Create another notice for a different company.');

    const published = before.publishedAt != null;
    const stored: StoredCriteria =
      c.targetMode === 'individual' ? { employmentIds: c.employmentIds } : c.criteria;

    const written=await tx
      .update(notice)
      .set({
        title: c.title,
        body: c.body,
        summary:c.summary,category:c.category,pinned:c.pinned,requiresAcknowledgement:c.requiresAcknowledgement,attachmentIds:c.attachmentIds,
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
      .where(eq(notice.id, id)).returning({id:notice.id});
    requireNoticeWrite(written);

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.updated',
      actor: actorOf(ctx),
      payload: {
        presentation:{category:c.category,pinned:c.pinned},
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
    const [row] = await tx.select().from(notice).where(authoringNotice(id)).limit(1).for('update');
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.archivedAt) throw new NoticeError('An archived notice cannot be published.');
    if (row.publishedAt) throw new NoticeError('That notice has already been published.');

    const audience=await resolveNoticeAudienceTx(tx,ctx,row,asOf);
    if(audience.invalid)throw new NoticeError('Some employee references are unavailable. Review the audience before publishing.');
    if(audience.incomplete)throw new NoticeError('Some employees are outside this notice’s authoring scope. Review the audience before publishing.');
    const recipientIds=audience.ids;
    if(!recipientIds.length)throw new NoticeError('No employees matched — this notice would reach nobody.');

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

    const written=await tx
      .update(notice)
      .set({ publishedAt: sql`now()`, publishedByUserId: actorUserId, updatedAt: sql`now()` })
      .where(eq(notice.id, id)).returning({id:notice.id});
    requireNoticeWrite(written);

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
        requiresAcknowledgement:row.requiresAcknowledgement,
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
    const [row] = await tx.select({ archivedAt: notice.archivedAt }).from(notice).where(authoringNotice(id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.archivedAt) throw new NoticeError('That notice is already archived.');
    const written=await tx
      .update(notice)
      .set({ archivedAt: sql`now()`, archivedByUserId: actorUserId, updatedAt: sql`now()` })
      .where(eq(notice.id, id)).returning({id:notice.id});
    requireNoticeWrite(written);
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
    const [row] = await tx.select({ archivedAt: notice.archivedAt }).from(notice).where(authoringNotice(id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (!row.archivedAt) throw new NoticeError('That notice is not archived.');
    const written=await tx
      .update(notice)
      .set({ archivedAt: null, archivedByUserId: null, updatedAt: sql`now()` })
      .where(eq(notice.id, id)).returning({id:notice.id});
    requireNoticeWrite(written);
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
    const [row] = await tx.select({ publishedAt: notice.publishedAt }).from(notice).where(authoringNotice(id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    if (row.publishedAt) {
      throw new NoticeError('A published notice cannot be deleted — archive it instead, so the record of what was announced survives.');
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'notice',
      aggregateId: id,
      eventType: 'notice.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
    requireNoticeWrite(await tx.delete(notice).where(eq(notice.id,id)).returning({id:notice.id}));
  });
}

/** Duplicate a notice as a fresh DRAFT — the reporter's "Duplicate" action. Copies content and targeting,
 *  never the publication: a copy that arrived pre-published would broadcast on the click of a button
 *  labelled Duplicate. */
export async function duplicateNotice(ctx: SessionContext, id: string): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(notice).where(authoringNotice(id)).limit(1);
    if (!row) throw new NoticeError('That notice could not be found.');
    const [copy] = await tx
      .insert(notice)
      .values({
        tenantId: ctx.tenantId,
        ownerCompanyId: row.ownerCompanyId,
        title: `${row.title} (copy)`.slice(0, 200),
        body: row.body,
        summary:row.summary,category:row.category,pinned:row.pinned,requiresAcknowledgement:row.requiresAcknowledgement,
        // A new announcement keeps content, never attachment IDs owned by its source.
        attachmentIds:[],
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
  ownerCompanyId: string | null;
  ownerCompanyName: string | null;
  summary:string;category:string|null;pinned:boolean;requiresAcknowledgement:boolean;contentVersion:number;attachmentIds:string[];
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
        summary:notice.summary,category:notice.category,pinned:notice.pinned,requiresAcknowledgement:notice.requiresAcknowledgement,contentVersion:notice.contentVersion,attachmentIds:notice.attachmentIds,
        ownerCompanyId: notice.ownerCompanyId,
        ownerCompanyName:sql<string|null>`(SELECT c.legal_name FROM public.company c WHERE c.id=notice.owner_company_id AND c.tenant_id=notice.tenant_id)`,
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
      .where(and(sql`app.can_manage_notice(${notice.id})`,opts.includeArchived ? undefined : isNull(notice.archivedAt)))
      .orderBy(desc(notice.createdAt),asc(notice.id));
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
  summary:string;category:string|null;pinned:boolean;requiresAcknowledgement:boolean;contentVersion:number;attachmentIds:string[];
  acknowledgedAt:Date|null;
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
        summary:notice.summary,category:notice.category,pinned:notice.pinned,requiresAcknowledgement:notice.requiresAcknowledgement,contentVersion:notice.contentVersion,attachmentIds:notice.attachmentIds,
        title: notice.title,
        body: notice.body,
        startOn: notice.startOn,
        endOn: notice.endOn,
        showEndDate: notice.showEndDate,
        publishedAt: notice.publishedAt,
        popupEnabled: notice.popupEnabled,
        popupFrequency: notice.popupFrequency,
        acknowledgedAt:sql<Date|null>`(SELECT a.acknowledged_at FROM public.notice_acknowledgement a
          WHERE a.recipient_id=notice_recipient.id AND a.tenant_id=notice_recipient.tenant_id AND a.notice_id=notice.id AND a.content_version=notice.content_version LIMIT 1)`,
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
      .orderBy(desc(notice.pinned),desc(notice.publishedAt),asc(notice.id));
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
 *   • 'until_acknowledged' — show while live until the current required content version is acknowledged.
 *     Without an acknowledgement requirement, retain the existing every-login-through-expiry behavior.
 */
export function popupNoticeFor(rows: readonly EmployeeNoticeRow[]): EmployeeNoticeRow | null {
  const due = rows.filter((r) => {
    if (!r.popupEnabled) return false;
    if (r.popupFrequency === 'until_acknowledged') return !r.requiresAcknowledgement||r.acknowledgedAt==null;
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


/** Retained HR history is scoped by the immutable parent owner. */
export function noticeContentHistory(ctx:SessionContext,id:string){
 return withTenant(ctx,tx=>tx.select().from(noticeRevision).where(and(eq(noticeRevision.noticeId,id),eq(noticeRevision.tenantId,ctx.tenantId))).orderBy(desc(noticeRevision.ordinal),asc(noticeRevision.id)));
}
export type NoticeAcknowledgementReceipt={id:string;contentVersion:number;acknowledgedAt:Date};
/** A deliberate action, not a page-load or popup marker. The purpose-bound database command owns the
 * actual principal, immutable timestamp, same-transaction audit and replay/stale-version contract. */
export async function acknowledgeNotice(ctx:SessionContext,id:string,employmentId:string,contentVersion:number,context:{reportedChannel?:string;reportedUserAgent?:string}={}):Promise<NoticeAcknowledgementReceipt>{
 if(!uuidNotice(id)||!uuidNotice(employmentId)||!Number.isSafeInteger(contentVersion)||contentVersion<1)throw new NoticeError('Notice acknowledgement is unavailable.');
 const requestContext={...(context.reportedChannel?{reportedChannel:context.reportedChannel.slice(0,32)}:{}),...(context.reportedUserAgent?{reportedUserAgent:context.reportedUserAgent.slice(0,256)}:{})};
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`SELECT * FROM app.acknowledge_notice(${id}::uuid,${contentVersion}::integer,${employmentId}::uuid,${JSON.stringify(requestContext)}::jsonb)`) as unknown as {receipt_id:string;content_version:number;acknowledged_at:Date|string}[];
  if(!row)throw new NoticeError('Notice acknowledgement is unavailable.');
  return {id:row.receipt_id,contentVersion:row.content_version,acknowledgedAt:new Date(row.acknowledged_at)};
 });
}
export function noticeAcknowledgementHistory(ctx:SessionContext,id:string){
 return withTenant(ctx,tx=>tx.select({id:noticeAcknowledgement.id,revisionId:noticeAcknowledgement.revisionId,contentVersion:noticeAcknowledgement.contentVersion,employmentId:noticeAcknowledgement.employmentId,actorUserId:noticeAcknowledgement.actorUserId,acknowledgedAt:noticeAcknowledgement.acknowledgedAt})
  .from(noticeAcknowledgement).where(and(eq(noticeAcknowledgement.noticeId,id),eq(noticeAcknowledgement.tenantId,ctx.tenantId))).orderBy(asc(noticeAcknowledgement.acknowledgedAt),asc(noticeAcknowledgement.id)));
}


export const NOTICE_ATTACHMENT_MAX_BYTES=10*1024*1024;
const noticeAttachmentMime=new Set(['application/pdf','image/png','image/jpeg','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation']);
/** Adds and selects immutable bytes in the same transaction as the content revision and audit event.
 * An intent key belongs to this author/Notice; a successful retry cannot manufacture another revision. */
export async function addNoticeAttachment(ctx:SessionContext,id:string,expectedContentVersion:number,p:{uploadKey:string;fileName:string;content:Buffer},options:{attach?:boolean}={}):Promise<{id:string;contentVersion:number;attachment:{id:string;fileName:string;mimeType:string;byteLength:number}}>{
 const actor=requireActor(ctx,'updated');
 if(!uuidNotice(id)||!uuidNotice(p.uploadKey)||!Number.isSafeInteger(expectedContentVersion)||expectedContentVersion<0)throw new NoticeError('Reload the notice before uploading.');
 const fileName=p.fileName.trim();
 if(!fileName||fileName.length>180||/[\x00-\x1f\x7f/\\]/.test(fileName))throw new NoticeError('Choose a file with a safe name of at most 180 characters.');
 if(!Buffer.isBuffer(p.content)||!p.content.length||p.content.length>NOTICE_ATTACHMENT_MAX_BYTES)throw new NoticeError('Choose a non-empty file of at most 10 MiB.');
 const content=Buffer.from(p.content);let mimeType:string;
 try{mimeType=resolveDocumentUpload(fileName,content).mimeType;}catch{throw new NoticeError('The file contents or file type are not supported.');}
 if(!noticeAttachmentMime.has(mimeType))throw new NoticeError('The file type is not supported for notices.');
 const digest=createHash('sha256').update(content).digest('hex');
 return withTenant(ctx,async tx=>{
  const [parent]=await tx.select({id:notice.id,contentVersion:notice.contentVersion,attachmentIds:notice.attachmentIds,archivedAt:notice.archivedAt}).from(notice).where(authoringNotice(id)).limit(1).for('update');
  if(!parent||parent.archivedAt)throw new NoticeError('That notice is no longer available for editing.');
  const [prior]=await tx.select({id:noticeAttachment.id,fileName:noticeAttachment.fileName,mimeType:noticeAttachment.mimeType,digest:sql<string>`encode(sha256(${noticeAttachment.content}),'hex')`})
   .from(noticeAttachment).where(and(eq(noticeAttachment.noticeId,id),eq(noticeAttachment.tenantId,ctx.tenantId),eq(noticeAttachment.createdByUserId,actor),eq(noticeAttachment.uploadKey,p.uploadKey))).limit(1);
  if(prior){
   if(options.attach===false&&parent.contentVersion!==expectedContentVersion)throw new NoticeError('Notice content changed; reload before uploading.');
   if(prior.fileName!==fileName||prior.mimeType!==mimeType||prior.digest!==digest||(options.attach!==false&&!parent.attachmentIds.includes(prior.id)))throw new NoticeError('This upload changed; reload before choosing the file again.');
   return {id:prior.id,contentVersion:parent.contentVersion,attachment:{id:prior.id,fileName,mimeType,byteLength:content.byteLength}};
  }
  if(parent.contentVersion!==expectedContentVersion)throw new NoticeError('Notice content changed; reload before uploading.');
  if(parent.attachmentIds.length>=5)throw new NoticeError('A notice can contain at most five attachments.');
  const [asset]=await tx.insert(noticeAttachment).values({tenantId:ctx.tenantId,noticeId:id,uploadKey:p.uploadKey,fileName,mimeType,byteLength:content.byteLength,content,createdByUserId:actor}).returning({id:noticeAttachment.id});
  if(options.attach===false){
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'notice',aggregateId:id,eventType:'notice.attachment-uploaded',actor:actorOf(ctx),payload:{attachmentId:asset.id,byteLength:content.byteLength,mimeType}});
   return {id:asset.id,contentVersion:parent.contentVersion,attachment:{id:asset.id,fileName,mimeType,byteLength:content.byteLength}};
  }
  const changed=await tx.update(notice).set({attachmentIds:[...parent.attachmentIds,asset.id],updatedAt:sql`now()`}).where(authoringNotice(id)).returning({id:notice.id,contentVersion:notice.contentVersion});requireNoticeWrite(changed);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'notice',aggregateId:id,eventType:'notice.attachment-added',actor:actorOf(ctx),payload:{attachmentId:asset.id,byteLength:content.byteLength,mimeType,contentVersion:changed[0].contentVersion}});
  return {id:asset.id,contentVersion:changed[0].contentVersion,attachment:{id:asset.id,fileName,mimeType,byteLength:content.byteLength}};
 });
}
/** Only this by-ID read touches bytes. RLS admits actual authors or live snapshot recipients of a
 * currently referenced attachment; a URL never enlarges a Knowledge Base document's audience. */
export function getNoticeAttachment(ctx:SessionContext,id:string,attachmentId:string){
 if(!uuidNotice(id)||!uuidNotice(attachmentId))return Promise.resolve(null);
 return withTenant(ctx,async tx=>{
  const [asset]=await tx.select({id:noticeAttachment.id,fileName:noticeAttachment.fileName,mimeType:noticeAttachment.mimeType,byteLength:noticeAttachment.byteLength,content:noticeAttachment.content}).from(noticeAttachment)
   .where(and(eq(noticeAttachment.tenantId,ctx.tenantId),eq(noticeAttachment.noticeId,id),eq(noticeAttachment.id,attachmentId))).limit(1);return asset??null;
 });
}
export function noticeAttachmentMetadata(ctx:SessionContext,id:string){
 return withTenant(ctx,tx=>tx.select({id:noticeAttachment.id,fileName:noticeAttachment.fileName,mimeType:noticeAttachment.mimeType,byteLength:noticeAttachment.byteLength}).from(noticeAttachment)
  .where(and(eq(noticeAttachment.tenantId,ctx.tenantId),eq(noticeAttachment.noticeId,id),sql`${noticeAttachment.id}=ANY((SELECT n.attachment_ids FROM public.notice n WHERE n.id=${id}::uuid AND n.tenant_id=${ctx.tenantId}::uuid)::uuid[])`))
  .orderBy(asc(noticeAttachment.createdAt),asc(noticeAttachment.id)).limit(5));
}

/** The uploader admits only actual current authors before consuming a request body; the writer checks
 * again under the parent lock after upload. No notice body or audience is needed for admission. */
export function noticeAttachmentUploadState(ctx:SessionContext,id:string){
 if(!uuidNotice(id))return Promise.resolve(null);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.select({id:notice.id,contentVersion:notice.contentVersion}).from(notice).where(and(authoringNotice(id),isNull(notice.archivedAt))).limit(1);return row??null;
 });
}
