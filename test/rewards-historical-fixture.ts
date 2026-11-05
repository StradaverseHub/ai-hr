/** Trusted test-owner setup for preserved pre-admission annual rows, never a production create path.
 * No current company/year registration or applied-library binding is invented. Native calendar/access
 * owners must still authorize every operation after seeding. The fixture is deliberately empty. */
import {and,eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import type {SessionContext} from '../db/client';
import {rewardUnit,rewardMember,businessUnit} from '../db/schema';
import {owner} from './harness';
export async function historicalEmptyRewardUnit(ctx:SessionContext,templateUnitId:string,businessUnitId:string){
 return owner.withTenant(ctx,async tx=>{
  const [template]=await tx.select().from(rewardUnit).where(and(eq(rewardUnit.id,templateUnitId),eq(rewardUnit.tenantId,ctx.tenantId)));
  const [bu]=await tx.select().from(businessUnit).where(and(eq(businessUnit.id,businessUnitId),eq(businessUnit.tenantId,ctx.tenantId)));
  if(!template||template.kind!=='annual'||!bu||bu.companyId!==template.companyId)throw new Error('Historical fixture must retain the same tenant and employer.');
  const {unitGovernanceDigest:_privateBasis,...policy}=template.policy;
  const id=randomUUID();
  await tx.insert(rewardUnit).values({id,tenantId:ctx.tenantId,createdBy:ctx.userId!,cycleId:template.cycleId,companyId:template.companyId,businessUnitId,kind:'annual',policy,snapshotDate:template.snapshotDate,policyGroupVersionId:null,createdAt:template.createdAt});
  await tx.insert(rewardMember).values({tenantId:ctx.tenantId,unitId:id,userId:ctx.userId!,role:'gr'});
  return id;
 });
}
