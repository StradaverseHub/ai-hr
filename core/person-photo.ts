import {assertWorkforcePersonTx} from './workforce-access';
import {createHash} from 'node:crypto';
import {isAdmin} from '../lib/authz-model';
import {freshProfileEditPolicyTx,lockProfileEditPolicyTx} from './profile-edit-policy';
import {getSetting} from './entitlements';
import {EssProfileError} from '../lib/personnel-ess-model';
import type {Tx} from '../db/client';
/**
 * Employee profile photograph (b4682879). A 1:1 photo stored in the person_photo bytea SIDE TABLE
 * (schema.ts), mirroring core/admin.ts company-logo exactly. PNG/JPEG only; the mime is sniffed from magic
 * bytes in this canonical owner (SVG is excluded — scriptable).
 *
 * RLS (0164): READ = app.can_see_person(person_id) — the photo is visible EXACTLY where the employee's name
 * already is (self / admin / administrative-manager subtree), narrower than the tenant-wide logo read
 * because a face photo is personal data. HR retains upload/replace/remove; the independently enabled own-photo course only uploads/replaces.
 *
 * Substrate: every write appends a DomainEvent (aggregateType 'person') with ONLY derived, non-PII payload
 * fields — never the bytes and never the raw user-supplied fileName (PDPA / ADR-0030 posture).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employment, personPhoto, profileChangeRequest, profilePhotoProposal } from '../db/schema';

import {PHOTO_MAX_BYTES} from '../lib/profile-photo-limits';
export {PHOTO_MAX_BYTES} from '../lib/profile-photo-limits';
export const ALLOWED_PHOTO_MIME = ['image/png', 'image/jpeg'] as const;

/** Fail-closed photo validation (empty / oversized / disallowed MIME). */
function assertValidPhoto(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new Error('Empty file');
  if (content.byteLength > PHOTO_MAX_BYTES) throw new Error('Photo exceeds 2 MB');
  if (profilePhotoMime(content)!==mimeType || !(ALLOWED_PHOTO_MIME as readonly string[]).includes(mimeType)) {
    throw new Error('Only PNG or JPG images are allowed');
  }
}

/** Upsert a person's profile photo (insert-or-update on the unique person_id). Admin-write (RLS). */
export async function setPersonPhoto(
  ctx: SessionContext,
  p: { personId: string; content: Buffer; fileName: string; mimeType: string; sizeBytes: number },
) {
  if(!isAdmin(ctx))throw new EssProfileError('permission');
  assertValidPhoto(p.mimeType, p.content);
  if(p.sizeBytes!==p.content.byteLength)throw new EssProfileError('invalid');
  return withTenant(ctx, async (tx) => {
    await assertWorkforcePersonTx(tx,ctx,p.personId,'maintain');
    return setPersonPhotoTx(tx,ctx,p);
  });
}

/** Byte sniffing belongs to the canonical owner, including non-browser callers. */
export function profilePhotoMime(content:Buffer):'image/png'|'image/jpeg'|null{
 if(content.length>=8&&content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(content.length>=3&&content[0]===255&&content[1]===216&&content[2]===255)return 'image/jpeg';
 return null;
}
async function setPersonPhotoTx(tx:Tx,ctx:SessionContext,p:{personId:string;content:Buffer;fileName:string;mimeType:string;sizeBytes:number}){
    await lockProfileEditPolicyTx(tx,ctx.tenantId);
    await lockPersonPhotoTx(tx,ctx,p.personId);
    await tx
      .insert(personPhoto)
      .values({
        tenantId: ctx.tenantId,
        personId: p.personId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
        uploadedByUserId: ctx.userId ?? null,
      })
      .onConflictDoUpdate({
        target: personPhoto.personId,
        set: {
          content: p.content,
          fileName: p.fileName,
          mimeType: p.mimeType,
          sizeBytes: p.sizeBytes,
          uploadedByUserId: ctx.userId ?? null,
          updatedAt: sql`now()`,
        },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.photo.set',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      payload: { mimeType: p.mimeType, sizeBytes: p.sizeBytes },
    });
    return { personId: p.personId };
}
import {isProfilePhotoProposal,PROFILE_PHOTO_FIELD} from '../lib/profile-photo-proposal';
import {isOwnPersonTx} from './own-person';
import {isProfileVisibilityPolicyValue,profileGroupPermission} from '../lib/profile-edit-policy-value';
import {personnelField} from '../lib/personnel-field-registry';
import {resolveProfileRouteTx,assertProfileRouteDecisionTx} from './profile-routing';
async function lockPersonPhotoTx(tx:Tx,ctx:SessionContext,personId:string){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'person-photo:'+ctx.tenantId+':'+personId},0))`);}
export function ownPhotoSubmissionAllowed(policy:Awaited<ReturnType<typeof freshProfileEditPolicyTx>>){
 const raw=getSetting(policy.ctx,'ess.profile_change_fields'),field=personnelField(PROFILE_PHOTO_FIELD)!;
 return getSetting(policy.ctx,'ess.profile_photo_edit')===true&&policy.visible.has(PROFILE_PHOTO_FIELD)&&(!isProfileVisibilityPolicyValue(raw)||profileGroupPermission(raw,field)==='editable');
}
async function photoBaselineTx(tx:Tx,personId:string){
 const [row]=await tx.select({content:personPhoto.content,mimeType:personPhoto.mimeType}).from(personPhoto).where(eq(personPhoto.personId,personId)).limit(1);
 return createHash('sha256').update(row?row.mimeType+':':'absent:').update(row?.content??Buffer.alloc(0)).digest('hex');
}
/** Own upload submits one proposal. The current master stays unchanged until a valid HR decision. */
export function setOwnPersonPhoto(ctx:SessionContext,p:{employmentId:string;content:Buffer;fileName:string}){
 const mimeType=profilePhotoMime(p.content);if(!mimeType)throw new EssProfileError('invalid');assertValidPhoto(mimeType,p.content);
 return withTenant(ctx,async tx=>{
  const policy=await freshProfileEditPolicyTx(tx,ctx);
  if(!ctx.userId||!ownPhotoSubmissionAllowed(policy))throw new EssProfileError('permission');
  const {ownProfileSubjectTx}=await import('./profile-edit');
  const {subject}=await ownProfileSubjectTx(tx,policy.ctx,p.employmentId);
  const route=await resolveProfileRouteTx(tx,policy.ctx,p.employmentId,'photo');
  if(!route)throw new EssProfileError('unavailable');
  await lockPersonPhotoTx(tx,ctx,subject.personId);
  const proposed={v:3,kind:'photo',fieldId:PROFILE_PHOTO_FIELD,baselineHash:await photoBaselineTx(tx,subject.personId)};
  const pending=await tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,content:profilePhotoProposal.content}).from(profileChangeRequest).innerJoin(profilePhotoProposal,eq(profilePhotoProposal.requestId,profileChangeRequest.id)).where(and(eq(profileChangeRequest.personId,subject.personId),eq(profileChangeRequest.status,'pending'),sql`${profileChangeRequest.proposed}->>'kind'='photo'`)).orderBy(profileChangeRequest.id).limit(2);
  if(pending.length){if(pending.length===1&&pending[0].employmentId===p.employmentId&&pending[0].content.equals(p.content))return {requestId:pending[0].id};throw new EssProfileError('stale');}
  const [row]=await tx.insert(profileChangeRequest).values({tenantId:ctx.tenantId,employmentId:p.employmentId,personId:subject.personId,proposed,...route}).returning({id:profileChangeRequest.id});
  await tx.insert(profilePhotoProposal).values({tenantId:ctx.tenantId,requestId:row.id,content:p.content,mimeType,sizeBytes:p.content.byteLength});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'profile-change',aggregateId:row.id,eventType:'profile-change.requested',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{fields:[PROFILE_PHOTO_FIELD],routeId:route.routeId,routeRevision:route.routeRevision,approverEmploymentId:route.routeApproverEmploymentId}});
  return {requestId:row.id};
 });
}
/** Called only after the canonical decision owner rechecks route, state, reviewer and self refusal. */
export async function applyProfilePhotoProposalTx(tx:Tx,ctx:SessionContext,request:typeof profileChangeRequest.$inferSelect){
 if(!isProfilePhotoProposal(request.proposed))throw new EssProfileError('invalid');
 const policy=await freshProfileEditPolicyTx(tx,ctx);if(!ownPhotoSubmissionAllowed(policy))throw new EssProfileError('fieldClosed',[PROFILE_PHOTO_FIELD]);
 // The subject must still be active and have a live login; the reviewer is not the subject context.
 const [active]=await tx.execute(sql`select exists(select 1 from employment e join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id where e.id=${request.employmentId}::uuid and e.person_id=${request.personId}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.blacklisted_at is null and e.hired_on<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (least(e.resignation_date,e.last_working_date,e.terminated_on) is null or least(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() at time zone 'Asia/Kuala_Lumpur')::date) and u.archived_at is null and not app.login_blocked(u.id)) allowed`);
 if(active?.allowed!==true)throw new EssProfileError('unavailable');
 await lockPersonPhotoTx(tx,ctx,request.personId);
 if(await photoBaselineTx(tx,request.personId)!==request.proposed.baselineHash)throw new EssProfileError('stale');
 const [photo]=await tx.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,request.id)).limit(1);
 if(!photo)throw new EssProfileError('unavailable');assertValidPhoto(photo.mimeType,photo.content);
 return setPersonPhotoTx(tx,ctx,{personId:request.personId,content:photo.content,mimeType:photo.mimeType,sizeBytes:photo.content.byteLength,fileName:'profile-photo'+(photo.mimeType==='image/png'?'.png':'.jpg')});
}
/** Pending proposal bytes have their own request visibility; no extra master/Personnel authority. */
export function getProfilePhotoProposal(ctx:SessionContext,requestId:string){
 return withTenant(ctx,async tx=>{
  const policy=await freshProfileEditPolicyTx(tx,ctx);
  const [request]=await tx.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId)).limit(1);
  if(!request||request.status!=='pending'||!isProfilePhotoProposal(request.proposed))return null;
  const own=request.personId===ctx.personId&&await isOwnPersonTx(tx,policy.ctx);
  if(own&&!policy.visible.has(PROFILE_PHOTO_FIELD))return null;
  if(!own){try{await assertProfileRouteDecisionTx(tx,policy.ctx,request);}catch{return null;}}
  const [row]=await tx.select({content:profilePhotoProposal.content,mimeType:profilePhotoProposal.mimeType}).from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId)).limit(1);
  return row??null;
 });
}

/** Remove a person's profile photo. No-op-safe if none exists. */
export async function removePersonPhoto(ctx: SessionContext, p: { personId: string }) {
  if(!isAdmin(ctx))throw new EssProfileError('permission');
  return withTenant(ctx, async (tx) => {
    await assertWorkforcePersonTx(tx,ctx,p.personId,'maintain');
    await lockProfileEditPolicyTx(tx,ctx.tenantId);
    await lockPersonPhotoTx(tx,ctx,p.personId);
    await tx.delete(personPhoto).where(eq(personPhoto.personId, p.personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: p.personId,
      eventType: 'person.photo.removed',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      payload: { removed: true },
    });
    return { personId: p.personId };
  });
}

/** Read a person's photo bytes for the serve route (RLS scopes visibility to can_see_person). */
export async function getPersonPhoto(
  ctx: SessionContext,
  personId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    if(personId===ctx.personId&&!isAdmin(ctx)){const policy=await freshProfileEditPolicyTx(tx,ctx);if(!policy.visible.has('profile.personal_details.photo'))return null;}
    const [row] = await tx
      .select({ content: personPhoto.content, fileName: personPhoto.fileName, mimeType: personPhoto.mimeType })
      .from(personPhoto)
      .where(eq(personPhoto.personId, personId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

/** Lightweight existence check for rendering (never pulls the blob). Returns true if the person has a
 *  photo the caller may see (RLS-scoped). */
export async function hasPersonPhoto(ctx: SessionContext, personId: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: personPhoto.id })
      .from(personPhoto)
      .where(eq(personPhoto.personId, personId))
      .limit(1);
    return row != null;
  });
}

/**
 * 597c810a — WHICH of these employments' people have a photo, in ONE query. This is THE bulk photo read;
 * there is deliberately no person-keyed twin (see the note at the end).
 *
 * WHY A BULK READ AND NOT `hasPersonPhoto` PER ROW: production holds 89 persons and 2 photos, so the naive
 * version issues 89 HTTP requests per list load, 87 of which are 404s that each cost a session read and an
 * RLS-scoped query. This is one round trip for the whole page.
 *
 * WHY IT IS KEYED BY EMPLOYMENT. Both Personnel listings render rows from `core/read.ts#listEmployeesPage`,
 * whose projection carries `employmentId` and no `personId`, and the photo route is keyed by person (a photo
 * is a PERSON fact — concurrent employments share one). Rather than widen that projection, this resolves the
 * two together: one query joins employment → person_photo and returns employmentId → personId for the
 * employments whose person has a photo the caller may see. The Map's VALUE is what the row needs anyway (the
 * serve URL is `/personnel/photo/<personId>`), so the caller never has to hold a second lookup.
 *
 * THIS IS NOT A WAY TO PROBE EXISTENCE OUTSIDE `can_see_person`. The predicate is RLS's, not a filter this
 * function applies, and it is the person_photo side of the join that fences it: employment is readable more
 * widely than a face photo is, so an employment whose person is outside app.can_see_person yields no joined
 * photo row and is simply absent from the Map — indistinguishable from "has no photo". An employment id from
 * another tenant, or one the caller cannot see, therefore tells the caller nothing.
 *
 * An empty input list short-circuits (an `inArray` on an empty array is a SQL syntax error in some dialects
 * and a pointless round trip in all).
 *
 * WHAT WENT AND WHY (r340 fix pass): `personsWithPhotos`, the person-keyed twin of this function, shipped
 * in 597c810a with tests and NO caller — nothing in app/, components/ or lib/ ever asked for it, because
 * both listings hold employment ids and the eleven other avatars on the product are out of this item's
 * scope. It was the TESTED path while this one was the live path, which is the wrong way round; its
 * scope cases (cross-tenant, non-admin, duplicate and blank ids) moved onto this function in
 * test/person-photo-bulk-597c810a.test.ts rather than being deleted with it.
 */
export async function employmentPhotoIds(
  ctx: SessionContext,
  employmentIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(employmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ employmentId: employment.id, personId: personPhoto.personId })
      .from(employment)
      .innerJoin(personPhoto, eq(personPhoto.personId, employment.personId))
      .where(inArray(employment.id, ids));
    return new Map(rows.map((r) => [r.employmentId, r.personId]));
  });
}
