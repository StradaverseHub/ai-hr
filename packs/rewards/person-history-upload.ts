import 'server-only';
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {withRewardsTenant} from '../../core/module-gate';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {bulkJobProgress,enqueueBulkJobTx,readBulkJob,listBulkJobsTx} from '../../core/bulk-job';
import {parseCsvWithLineNumbers} from '../../lib/csv';
import {assertRewardWritableTx} from './access-policy';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {rewardHistoryUploadFromCells,rewardHistoryUploadRowSchema,type RewardHistoryUploadRow} from './person-history-model';

export const REWARD_HISTORY_IMPORT_KIND='reward_person_history';
type ResolvedRow={line:number;value:RewardHistoryUploadRow;employmentId:string};
export type RewardHistoryImportPreview={token:string;rows:ResolvedRow[];problems:{line:number;reason:string}[];firstReviewYear:number|null};
export async function rewardHistoryImportAuthorityTx(tx:Tx,companyId:string){
 const [actor]=await tx.execute<{allowed:boolean}>(sql`select app.principal_snapshot_current() and app.reward_not_viewing_as()
  and app.reward_setup_allowed(NULL,'manage') and app.reward_setup_allowed(${companyId}::uuid,'manage')
  and app.reward_actor_holds_role('gr') as allowed`);
 if(!actor?.allowed)throw Error('Group Rewards with group setup authority is required to upload reward history.');
}
const inputSchema=z.object({companyId:z.uuid(),csv:z.string().min(1).max(5_000_000),name:z.string().trim().min(1).max(200)}).strict();
/** The preview binds employee codes in the selected company in one statement, never a query per row. */
export async function previewRewardPersonHistoryImport(ctx:SessionContext,raw:unknown):Promise<RewardHistoryImportPreview>{
 const input=inputSchema.parse(raw);
 return withRewardsTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);await rewardHistoryImportAuthorityTx(tx,input.companyId);
  const csv=parseCsvWithLineNumbers(input.csv,true),parsed=rewardHistoryUploadFromCells(csv.map(row=>row.cells),csv.map(row=>row.line));
  const codes=[...new Set(parsed.rows.map(row=>row.value.employeeCode))];
  const codeArray=sql`ARRAY[${sql.join(codes.map(code=>sql`${code}`),sql`, `)}]::text[]`;
  const [context]=await tx.execute<{value:{people:{id:string;code:string}[];firstReviewYear:number|null}}>(sql`select app.reward_history_upload_context(${input.companyId}::uuid,${codeArray}) as value`);
  if(!context?.value)throw Error('Reward history upload is unavailable.');
  const people=new Map<string,string[]>();for(const person of context.value.people)people.set(person.code,[...(people.get(person.code)??[]),person.id]);
  const firstReviewYear=context.value.firstReviewYear;
  const problems=[...parsed.problems],rows:ResolvedRow[]=[];
  for(const row of parsed.rows){
   const matches=people.get(row.value.employeeCode)??[];
   if(matches.length!==1)problems.push({line:row.line,reason:'Employee ID is unavailable or ambiguous in this company.'});
   else if(row.value.year>=Number(todayInKualaLumpur().slice(0,4)))problems.push({line:row.line,reason:'Upload completed historical years only.'});
   else if(firstReviewYear!==null&&row.value.year>=firstReviewYear)problems.push({line:row.line,reason:'Upload only years before the company’s first posted AI-HR Rewards review.'});
   else rows.push({...row,employmentId:matches[0]});
  }
  const token=createHash('sha256').update(JSON.stringify({tenantId:ctx.tenantId,userId:ctx.userId,companyId:input.companyId,rows,problems,cutoff:firstReviewYear})).digest('hex');
  return{token,rows,problems,firstReviewYear};
 });
}
/** Confirmation admits background work only. All rows are rechecked by the protected worker. */
export async function importRewardPersonHistory(ctx:SessionContext,raw:unknown,expectedToken:string){
 const input=inputSchema.parse(raw),preview=await previewRewardPersonHistoryImport(ctx,input);
 if(preview.token!==expectedToken||preview.problems.length||!preview.rows.length)throw Error('Review a valid, current history preview before saving.');
 return withRewardsTenant(ctx,async tx=>{
  await assertRewardWritableTx(tx);await rewardHistoryImportAuthorityTx(tx,input.companyId);
  const admitted=await enqueueBulkJobTx(tx,ctx,{kind:REWARD_HISTORY_IMPORT_KIND,companyIds:[input.companyId],source:{name:input.name,content:Buffer.from(input.csv)},input:{companyId:input.companyId,token:expectedToken}});
  return{jobId:admitted.row.id,existing:admitted.existing};
 });
}
export async function rewardPersonHistoryImportProgress(ctx:SessionContext,id:string){return bulkJobProgress(await readBulkJob(ctx,id,REWARD_HISTORY_IMPORT_KIND));}
export async function latestRewardPersonHistoryImport(ctx:SessionContext){return withRewardsTenant(ctx,async tx=>{
 const [job]=await listBulkJobsTx(tx,ctx,REWARD_HISTORY_IMPORT_KIND,1);return job?bulkJobProgress(job):null;
});}

/** Each checkpoint is one person-year. Superseding retains the old row and its immutable financial facts. */
export async function applyRewardPersonHistoryImportRowTx(tx:Tx,ctx:SessionContext,companyId:string,jobId:string,raw:ResolvedRow){
 const value=rewardHistoryUploadRowSchema.parse(raw.value),employmentId=z.uuid().parse(raw.employmentId);
 await rewardHistoryImportAuthorityTx(tx,companyId);
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`reward-history:${ctx.tenantId}:${employmentId}:${value.year}:${value.kind}`},0))`);
 const [context]=await tx.execute<{value:{people:{id:string;code:string}[];firstReviewYear:number|null}}>(sql`select app.reward_history_upload_context(${companyId}::uuid,ARRAY[${value.employeeCode}]::text[]) as value`);
 if(!context?.value||context.value.people.length!==1||context.value.people[0].id!==employmentId||value.year>=Number(todayInKualaLumpur().slice(0,4))||(context.value.firstReviewYear!==null&&value.year>=context.value.firstReviewYear))throw Error('The employee or allowable history years changed. Preview the file again.');
 const previous=await tx.execute<{id:string}>(sql`update reward_person_history set superseded_at=now() where tenant_id=app.current_tenant_id()
  and company_id=${companyId}::uuid and employment_id=${employmentId}::uuid and year=${value.year} and kind=${value.kind} and source='upload' and superseded_at is null returning id`);
 await tx.execute(sql`insert into reward_person_history(tenant_id,company_id,employment_id,year,kind,source,upload_batch_id,talent,performance,merit_bp,promotion_bp,special_bp,
  increment_cents,total_increase_bp,promoted,promotion_grade,bonus_cents,bonus_months_bp,lump_cents,withheld,created_by)
 values(app.current_tenant_id(),${companyId}::uuid,${employmentId}::uuid,${value.year},${value.kind},'upload',${jobId}::uuid,${value.talent},${value.performance},${value.incrementBp},0,0,
  ${value.incrementCents},${value.incrementBp},false,null,${value.bonusCents},${value.bonusMonthsBp},0,'{}'::jsonb,app.current_user_id())`);
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-person-history',aggregateId:jobId,eventType:'reward-person-history.uploaded',actor:actorOf(ctx),
  payload:{employmentId,year:value.year,kind:value.kind,source:'upload',supersededIds:previous.map(row=>row.id),line:raw.line}});
}

export async function rewardHistoryUploadCompanies(ctx:SessionContext){return withRewardsTenant(ctx,async tx=>{
 await lockAccessConfigurationReadTx(tx,ctx.tenantId);
 return[...await tx.execute<{id:string;name:string}>(sql`select id,legal_name as name from company where tenant_id=app.current_tenant_id()
  and archived_at is null and app.reward_history_upload_authorized(id) order by legal_name,id`)];
});}
