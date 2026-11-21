/** Test-only oracle: the Claims approvals queue exactly as core/claims.ts read it before the batched queue
 * (pendingClaimQueueTx, listPendingClaimsPage and listPendingClaimSelection at a8ed2dc87). Never a product
 * reader. The detail rows of a former page were the base inbox rows (listPendingClaims, unchanged) for the
 * page's ids in the sorted order. */
import {desc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import * as schema from '../../db/schema';
import {assertAssignedWorkPrincipalTx,filterDelegationOrgScopeTx} from '../../core/approvals';
import {listPendingClaims} from '../../packs/claims/service';
import {sortApprovalRows,type ApprovalSort} from '../../lib/approvals-sort';
import {pageState,parsePageQuery} from '../../lib/pagination';

/** Every pending claim under request RLS joined to its type, the scalar subject function once per claim
 * row, then the delegate org-scope trim. `statementTimeoutMs` only bounds a measured scale rehearsal. */
export function legacyClaimQueue(ctx:SessionContext,options:{statementTimeoutMs?:number}={}){
 return withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  if(options.statementTimeoutMs!==undefined){
   if(!Number.isSafeInteger(options.statementTimeoutMs)||options.statementTimeoutMs<1)throw new TypeError('Invalid legacy timeout');
   await tx.execute(sql.raw(`set local statement_timeout=${options.statementTimeoutMs}`));
  }
  const rows=await tx.select({id:schema.claimRequest.id,employmentId:schema.claimRequest.employmentId,createdAt:schema.claimRequest.createdAt,
    claimantName:sql<string>`approval_subject.employee`,personId:sql<string>`approval_subject.person_id`})
   .from(schema.claimRequest)
   .innerJoin(schema.claimType,eq(schema.claimType.id,schema.claimRequest.claimTypeId))
   .innerJoin(sql`LATERAL app.delegated_approval_subject(${schema.claimRequest.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
   .where(eq(schema.claimRequest.status,'pending'))
   .orderBy(desc(schema.claimRequest.createdAt));
  return filterDelegationOrgScopeTx(tx,ctx,rows,row=>row.employmentId);
 },{readOnlySnapshot:true});
}

export type LegacyClaimQueueRow=Awaited<ReturnType<typeof legacyClaimQueue>>[number];

/** The former in-memory sort over the whole queue. */
export function sortLegacyClaimQueue(queue:readonly LegacyClaimQueueRow[],sort:ApprovalSort){
 return sortApprovalRows(queue,sort,{id:row=>row.id,name:row=>row.claimantName,createdAt:row=>row.createdAt});
}

/** The former page, count and selection for one approver, from one read of the former queue. */
export async function legacyClaimInbox(ctx:SessionContext){
 const queue=await legacyClaimQueue(ctx);
 const base=await listPendingClaims(ctx),byId=new Map(base.map(row=>[row.id,row]));
 const page=(sort:ApprovalSort,opts:{page?:string;size?:string})=>{
  const query=parsePageQuery(opts),sorted=sortLegacyClaimQueue(queue,sort);
  const rows=sorted.slice(query.offset,query.offset+query.limit).flatMap(row=>{const found=byId.get(row.id);return found?[found]:[];});
  return {rows,page:pageState(query,sorted.length,rows.length)};
 };
 const selection=queue.filter(row=>!(ctx.personId!=null&&row.personId===ctx.personId)).map(row=>row.id).sort();
 return {queue,base,page,selection};
}
