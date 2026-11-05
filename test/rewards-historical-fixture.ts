/** Trusted test-owner setup for preserved pre-admission annual rows, never a production create path.
 * No current company/year registration or applied-library binding is invented. Native calendar/access
 * owners must still authorize every operation after seeding. The fixture is deliberately empty. */
import {and,eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import type {SessionContext} from '../db/client';
import {rewardUnit,rewardMember,businessUnit,rewardCycle,rewardEntry,rewardGovernance,rewardGovernancePublic,employment,person,labelCompanyAssignment} from '../db/schema';
import {defaultPolicy,emptyFacts,emptyRecommendation} from '../packs/rewards/model';
import {emptyGovernance,governanceBasis} from '../packs/rewards/governance-model';
import {owner} from './harness';
export async function historicalEmptyRewardUnit(ctx:SessionContext,templateUnitId:string,businessUnitId:string){
 return owner.withTenant(ctx,async tx=>{
  const [template]=await tx.select().from(rewardUnit).where(and(eq(rewardUnit.id,templateUnitId),eq(rewardUnit.tenantId,ctx.tenantId)));
  const [bu]=await tx.select().from(businessUnit).where(and(eq(businessUnit.id,businessUnitId),eq(businessUnit.tenantId,ctx.tenantId)));
  if(!template||template.kind!=='annual'||!bu||bu.companyId!==template.companyId)throw new Error('Historical fixture must retain the same tenant and employer.');
  if(!bu.isGlobal)await tx.insert(labelCompanyAssignment).values({tenantId:ctx.tenantId,labelKind:'business_unit',labelId:bu.id,companyId:template.companyId}).onConflictDoNothing();
  const {unitGovernanceDigest:_privateBasis,...policy}=template.policy;
  const id=randomUUID();
  await tx.insert(rewardUnit).values({id,tenantId:ctx.tenantId,createdBy:ctx.userId!,cycleId:template.cycleId,companyId:template.companyId,businessUnitId,kind:'annual',policy,snapshotDate:template.snapshotDate,policyGroupVersionId:null,createdAt:template.createdAt});
  await tx.insert(rewardMember).values({tenantId:ctx.tenantId,unitId:id,userId:ctx.userId!,role:'gr'});
  return id;
 });
}

/** Seed a pre-admission draft whose source and governance scaffolding still exist. */
export async function historicalRewardDraft(ctx:SessionContext,input:{
 name:string;year:number;companyId:string;businessUnitId:string;snapshotDate:string;employmentId:string;
}){
 return owner.withTenant(ctx,async tx=>{
  const [source]=await tx.select({employment,person}).from(employment)
   .innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId)))
   .where(and(eq(employment.id,input.employmentId),eq(employment.companyId,input.companyId),eq(employment.tenantId,ctx.tenantId)));
  if(!source||!ctx.userId)throw new Error('Historical draft requires a real source employee and author in its tenant.');
  const [bu]=await tx.select().from(businessUnit).where(and(eq(businessUnit.id,input.businessUnitId),eq(businessUnit.tenantId,ctx.tenantId)));
  if(!bu||bu.companyId!==input.companyId)throw new Error('Historical draft requires an actual Business unit in its employer.');
  if(!bu.isGlobal)await tx.insert(labelCompanyAssignment).values({tenantId:ctx.tenantId,labelKind:'business_unit',labelId:bu.id,companyId:input.companyId}).onConflictDoNothing();
  const [cycle]=await tx.insert(rewardCycle).values({tenantId:ctx.tenantId,name:input.name,year:input.year,createdBy:ctx.userId}).returning();
  const policy=defaultPolicy(input.year);
  const [unit]=await tx.insert(rewardUnit).values({
   tenantId:ctx.tenantId,createdBy:ctx.userId,cycleId:cycle.id,companyId:input.companyId,businessUnitId:input.businessUnitId,
   kind:'annual',policy,snapshotDate:input.snapshotDate,policyGroupVersionId:null,
  }).returning();
  await tx.insert(rewardMember).values({tenantId:ctx.tenantId,unitId:unit.id,userId:ctx.userId,role:'gr'});
  const [entry]=await tx.insert(rewardEntry).values({
   tenantId:ctx.tenantId,unitId:unit.id,employmentId:source.employment.id,facts:emptyFacts(),recommendation:emptyRecommendation(),
   source:{employmentId:source.employment.id,personId:source.person.id,employeeCode:source.employment.employeeCode??source.employment.id,
    name:source.person.fullName,grade:'',gradeId:source.employment.gradeId,compensationId:null,basicCents:0,currency:'MYR',payMode:'monthly',
    hiredOn:source.employment.hiredOn,confirmedOn:source.employment.confirmationDate,notice:false,lastPayChange:null,confirmationPayChange:false,
    performanceReviewId:null,performanceRating:null},
  }).returning();
  await tx.insert(rewardGovernance).values({tenantId:ctx.tenantId,unitId:unit.id,state:{
   ...emptyGovernance(),inputs:{forecastCents:null,actualCents:null,targetCents:null,targetMonthsBp:0,multiplierBp:null,branchRatings:{}},
   selection:{employmentIds:[],proposedBy:ctx.userId,confirmedBy:null,confirmedAt:null},
  }});
  await tx.insert(rewardGovernancePublic).values({tenantId:ctx.tenantId,unitId:unit.id,snapshot:{
   status:'not-set',pools:{standard:0,h:0},targetMonthsBp:0,multiplierBp:null,branchRatings:{},selectionConfirmed:false,previousPools:null,
   basis:governanceBasis(policy,[entry]),
  }});
  return unit.id;
 });
}
