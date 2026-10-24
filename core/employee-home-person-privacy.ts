/** Canonical person-wide celebration opt-outs. No peer, birth date/year, role-selected person or
 * employment-specific copy is read. These controls are independent of cosmetic Home preferences. */
import {and,desc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appUser,employeeHomePersonPrivacyRevision} from '../db/schema';
import {validateHomePersonPrivacyInput,type HomePersonPrivacy} from '../lib/employee-home-person-privacy';
export class HomePersonPrivacyAccessError extends Error{
 constructor(){super('The own celebration privacy context is unavailable');this.name='HomePersonPrivacyAccessError';}
}
export class HomePersonPrivacyChangedError extends Error{
 constructor(){super('Celebration privacy changed; reload before saving');this.name='HomePersonPrivacyChangedError';}
}
async function ownPersonTx(tx:Tx,ctx:SessionContext):Promise<string|null>{
 if(!ctx.userId)throw new HomePersonPrivacyAccessError();
 const [login]=await tx.select({personId:appUser.personId}).from(appUser).where(and(eq(appUser.id,ctx.userId),eq(appUser.tenantId,ctx.tenantId),
  sql`app.principal_snapshot_current() AND (${appUser.personId} IS NULL OR app.is_self_person(${appUser.personId}))`)).limit(1);
 if(!login||login.personId!==(ctx.personId??null))throw new HomePersonPrivacyAccessError();
 return login.personId;
}
async function currentTx(tx:Tx,ctx:SessionContext,personId:string):Promise<HomePersonPrivacy>{
 const [row]=await tx.select({ordinal:employeeHomePersonPrivacyRevision.ordinal,hideBirthday:employeeHomePersonPrivacyRevision.hideBirthday,
  hideAnniversary:employeeHomePersonPrivacyRevision.hideAnniversary}).from(employeeHomePersonPrivacyRevision)
  .where(and(eq(employeeHomePersonPrivacyRevision.tenantId,ctx.tenantId),eq(employeeHomePersonPrivacyRevision.personId,personId)))
  .orderBy(desc(employeeHomePersonPrivacyRevision.ordinal)).limit(1);
 return {version:1,ordinal:row?.ordinal??0,hideBirthday:row?.hideBirthday??false,hideAnniversary:row?.hideAnniversary??false};
}
export function readOwnHomePersonPrivacy(ctx:SessionContext):Promise<HomePersonPrivacy|null>{
 return withTenant(ctx,async tx=>{const personId=await ownPersonTx(tx,ctx);return personId?currentTx(tx,ctx,personId):null;});
}
export function saveOwnHomePersonPrivacy(ctx:SessionContext,raw:unknown):Promise<HomePersonPrivacy>{
 const input=validateHomePersonPrivacyInput(raw);
 return withTenant(ctx,async tx=>{
  // Refuse forged/unlinked identity with the public typed error before a configuration lock
  // can reject it at SQL level. Repeat the identity proof under the barrier below.
  if(!await ownPersonTx(tx,ctx))throw new HomePersonPrivacyAccessError();
  // Same first barrier as greeting Send/erasure. Taking the person advisory lock first would
  // invert their Person-row/FK order; the SQL trigger repeats this for direct application inserts.
  await tx.execute(sql`SELECT app.access_profile_policy_write_lock()`);
  const personId=await ownPersonTx(tx,ctx);if(!personId)throw new HomePersonPrivacyAccessError();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`home-person-privacy:${ctx.tenantId}:${personId}`},0))`);
  const previous=await currentTx(tx,ctx,personId);
  if(previous.ordinal!==input.expectedOrdinal)throw new HomePersonPrivacyChangedError();
  if(previous.ordinal>0&&previous.hideBirthday===input.hideBirthday&&previous.hideAnniversary===input.hideAnniversary)return previous;
  const [saved]=await tx.insert(employeeHomePersonPrivacyRevision).values({tenantId:ctx.tenantId,personId,ordinal:previous.ordinal+1,
   hideBirthday:input.hideBirthday,hideAnniversary:input.hideAnniversary,createdByUserId:ctx.userId!})
   .returning({ordinal:employeeHomePersonPrivacyRevision.ordinal,hideBirthday:employeeHomePersonPrivacyRevision.hideBirthday,hideAnniversary:employeeHomePersonPrivacyRevision.hideAnniversary});
  // The table's trigger appends the redacted audit in this transaction, including direct app inserts.
  return {version:1,...saved};
 });
}
