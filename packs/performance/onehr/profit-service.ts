import { and,asc,eq,inArray,sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext,Tx } from '../../../db/client';
import { withPerformanceTenant } from '../../../core/module-gate';
import { assessmentProfitAchievement,company } from '../../../db/schema';
import { auditAssessmentAdminTx,loadAssessmentAdminCycleTx } from './admin-context';
import type { ProfitAchievement } from './calibration-curve-model';
export async function lockProfitReferenceTx(tx:Tx,cycleId:string){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'assessment-profit:'+cycleId},0))`);}
export async function profitAchievementsTx(tx:Tx,cycleId:string,companyIds?:string[]):Promise<ProfitAchievement[]>{
 if(companyIds&&!companyIds.length)return [];
 const rows=await tx.select({companyId:assessmentProfitAchievement.companyId,achievementPct:assessmentProfitAchievement.achievementPct,revision:assessmentProfitAchievement.revision}).from(assessmentProfitAchievement).where(and(eq(assessmentProfitAchievement.cycleId,cycleId),companyIds?inArray(assessmentProfitAchievement.companyId,[...new Set(companyIds)]):undefined)).orderBy(asc(assessmentProfitAchievement.companyId));
 return rows.map(row=>({...row,achievementPct:row.achievementPct==null?null:Number(row.achievementPct)}));
}
export async function saveAssessmentProfitAchievement(ctx:SessionContext,cycleId:string,raw:unknown){
 z.uuid().parse(cycleId);const p=z.object({companyId:z.uuid(),revision:z.number().int().positive().nullable(),achievementPct:z.number().finite().nullable()}).parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  await loadAssessmentAdminCycleTx(tx,cycleId);await lockProfitReferenceTx(tx,cycleId);
  const [unit]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,p.companyId),sql`app.onehr_admin(${company.id})`));if(!unit)throw Error('Company outside your performance administration scope.');
  const [row]=await tx.select().from(assessmentProfitAchievement).where(and(eq(assessmentProfitAchievement.cycleId,cycleId),eq(assessmentProfitAchievement.companyId,p.companyId))).for('update');
  if((row?.revision??null)!==p.revision)throw Error('The company achievement changed. Reload before saving.');
  const data={achievementPct:p.achievementPct==null?null:String(p.achievementPct),updatedBy:ctx.userId,updatedAt:new Date()};
  if(row)await tx.update(assessmentProfitAchievement).set({...data,revision:row.revision+1}).where(eq(assessmentProfitAchievement.id,row.id));
  else await tx.insert(assessmentProfitAchievement).values({...data,tenantId:ctx.tenantId,cycleId,companyId:p.companyId});
  await auditAssessmentAdminTx(tx,ctx,cycleId,'profit-achievement-saved',{companyId:p.companyId,previous:row?.achievementPct??null,achievementPct:p.achievementPct});
 });
}
/** Compatibility for the original cohort form. A supplied figure must agree with the company fact. */
export async function seedCalibrationProfitTx(tx:Tx,ctx:SessionContext,cycleId:string,companyId:string|null,pct:number|null){
 if(pct==null)return;await lockProfitReferenceTx(tx,cycleId);if(!companyId)throw Error('Record profit achievement for a company or business group before assigning a mixed-company cohort.');
 const [row]=await tx.select().from(assessmentProfitAchievement).where(and(eq(assessmentProfitAchievement.cycleId,cycleId),eq(assessmentProfitAchievement.companyId,companyId))).for('update');
 if(row){if(row.achievementPct!=null&&Number(row.achievementPct)===pct)return;throw Error('This company already has an achievement figure. Update it in cycle configuration.');}
 await tx.insert(assessmentProfitAchievement).values({tenantId:ctx.tenantId,cycleId,companyId,achievementPct:String(pct),updatedBy:ctx.userId});
 await auditAssessmentAdminTx(tx,ctx,cycleId,'profit-achievement-saved',{companyId,previous:null,achievementPct:pct});
}
