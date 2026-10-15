import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../../db/client';
import {assessmentCatalogue,reviewCycle} from '../../../db/schema';
import {catalogueOf,mergeCatalogueChanges,policyWithCatalogue,type Catalogue} from './catalogue-default-model';
import {defaultPolicy,type Policy} from './model';
import framework from './framework.json';

/** Only catalogue definitions carry forward; dates, module switches and employee assignments do not. */
export async function assessmentDefaultPolicyTx(tx:Tx,companyId:string|null){
 const [row]=await tx.execute<{catalogue:Partial<Catalogue>|null}>(sql`select app.assessment_catalogue_defaults(${companyId}::uuid) as catalogue`);
 return policyWithCatalogue(defaultPolicy(framework),row?.catalogue??null);
}
/** The edited cycle remains a snapshot. Publish changed definitions atomically for newly created cycles. */
export async function publishAssessmentCatalogueTx(tx:Tx,ctx:SessionContext,cycleId:string,previous:Policy,next:Policy){
 const before=catalogueOf(previous),after=catalogueOf(next),technicalChanged=JSON.stringify([before.profiles,before.skills,before.careerRoutes])!==JSON.stringify([after.profiles,after.skills,after.careerRoutes]),frameworkChanged=JSON.stringify([before.framework,before.leadershipPrinciples])!==JSON.stringify([after.framework,after.leadershipPrinciples]);
 if(!technicalChanged&&!frameworkChanged)return;
 const [cycle]=await tx.select({companyId:reviewCycle.companyId}).from(reviewCycle).where(eq(reviewCycle.id,cycleId));if(!cycle)throw Error('Cycle not found.');
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':assessment-catalogue'},0))`);
 const save=async(companyId:string|null,technical:boolean,leadership:boolean)=>{
  const scopeKey=companyId??'group';
  const [held]=await tx.select().from(assessmentCatalogue).where(and(eq(assessmentCatalogue.tenantId,ctx.tenantId),eq(assessmentCatalogue.scopeKey,scopeKey))).for('update');
  const current=held?catalogueOf(policyWithCatalogue(defaultPolicy(framework),held.catalogue as Partial<Catalogue>)):(technical?before:{...before,profiles:[],skills:[],careerRoutes:[]});
  const selected={...before,...(technical?{profiles:after.profiles,skills:after.skills,careerRoutes:after.careerRoutes}:{}),...(leadership?{framework:after.framework,leadershipPrinciples:after.leadershipPrinciples}:{})};
  const merged=mergeCatalogueChanges(before,selected,current);
  // Validate routes and identities against the full merged catalogue before any write.
  policyWithCatalogue(defaultPolicy(framework),merged);
  const catalogue={profiles:merged.profiles,skills:merged.skills,careerRoutes:merged.careerRoutes,...(!companyId&&(leadership||held&&(held.catalogue as Partial<Catalogue>).framework)?{framework:merged.framework,leadershipPrinciples:merged.leadershipPrinciples}:{})};
  if(companyId&&catalogue.profiles.some(p=>p.companyId&&p.companyId!==companyId))throw Error('A company catalogue can contain only its own or shared profiles.');
  const values={catalogue,updatedBy:ctx.userId??null,updatedAt:new Date(),sourceCycleId:cycleId};
  if(held)await tx.update(assessmentCatalogue).set({...values,revision:held.revision+1}).where(eq(assessmentCatalogue.id,held.id));
  else await tx.insert(assessmentCatalogue).values({tenantId:ctx.tenantId,scopeKey,companyId,...values});
 };
 if(frameworkChanged)await save(null,!cycle.companyId&&technicalChanged,true);
 if(technicalChanged&&(cycle.companyId||!frameworkChanged))await save(cycle.companyId,true,false);
}
