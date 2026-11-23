import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertModuleGate} from './module-gate';
import {bulkJobProgress,bulkJobTx,enqueueBulkJobTx} from './bulk-job';
import type {BulkJobPreparedStepHandler} from './bulk-job-worker';
import {calculateTaxBasisPreview,continueTaxBasisBatch,planTaxBasisPreviewTx,prepareReviewedTaxBasisConfirmation,saveTaxBasisPreviewTx} from './payroll-tax-basis';
import {PayrollTaxBasisError,TAX_BASIS_PREVIEW_CHUNK_SIZE,type TaxBasisEmployee,type TaxBasisHistoryRow,type TaxBasisPreview,type TaxBasisSelection} from '../lib/payroll-tax-basis';

const KIND='payroll_tax_basis_group';
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const ids=(values:readonly string[])=>sql`array[${sql.join(values.map(value=>sql`${value}::uuid`),sql`,`)}]::uuid[]`;
const unavailable=()=>new PayrollTaxBasisError('The selected companies or recalculation preview are unavailable.');
type PreviewRef={companyId:string;previewId:string;previewHash:string;selectionMode?:TaxBasisPreview['selection']};
export const TAX_BASIS_GROUP_PAGE_SIZE=30;
type BatchRef={companyId:string;id:string|null};
type GroupResult={phase:'preview';refs:PreviewRef[]}|{phase:'confirmation';outcomes:(BatchRef&{error:string|null})[]};
type CompanyProgress={companyId:string;name:string;state:'pending'|'processing'|'completed'|'failed';total:number;processed:number;failures:number};
type Input={selections:TaxBasisSelection[]}|{previewJobId:string};
type Step=(TaxBasisSelection&{selectionMode?:TaxBasisPreview['selection']})|PreviewRef;

function validateSelections(selections:TaxBasisSelection[]){
 if(!Array.isArray(selections)||selections.length<1||selections.length>500)throw unavailable();
 const first=selections[0];
 if(selections.some(s=>!s||!validId(s.companyId)||!Number.isInteger(s.year)||s.year<1900||s.year>2999||
  !Number.isInteger(s.upToMonth)||s.upToMonth<1||s.upToMonth>12||s.year!==first.year||s.upToMonth!==first.upToMonth||
  (s.employmentIds!==null&&(!Array.isArray(s.employmentIds)||s.employmentIds.length>1000||
   s.employmentIds.some(id=>!validId(id))||new Set(s.employmentIds).size!==s.employmentIds.length)))||
  new Set(selections.map(s=>s.companyId)).size!==selections.length)throw unavailable();
}

async function checkCompanies(tx:Tx,ctx:SessionContext,companyIds:string[]){
 assertModuleGate(ctx,'payroll');
 if(!ctx.userId||!companyIds.length||companyIds.length>500)throw unavailable();
 const [row]=await tx.execute<{allowed:boolean}>(sql`
   select app.principal_snapshot_current() and count(*)=${companyIds.length} and
    coalesce(bool_and(app.can_admin_payroll_for(id)
      and app.payroll_tax_basis_permission(id,'payroll.tax-basis.view')
      and app.payroll_tax_basis_permission(id,'payroll.tax-basis.recalculate')),false) as allowed
   from company where tenant_id=${ctx.tenantId}::uuid and id=any(${ids(companyIds)}) and archived_at is null`);
 if(!row?.allowed)throw unavailable();
}

async function reviewedTx(tx:Tx,ctx:SessionContext,id:string){
 const job=await bulkJobTx(tx,id,{kind:KIND});
 await checkCompanies(tx,ctx,job.company_ids);
 const result=job.result as GroupResult|null;
 if(job.state!=='completed'||result?.phase!=='preview'||job.counters.failed)throw unavailable();
 const rows=await tx.execute<{preview:Omit<TaxBasisPreview,'employees'>;count:number}>(sql`
  select (p.preview-'employees')||jsonb_build_object('selection',
    coalesce(r.ref->>'selectionMode',p.preview->>'selection')) as preview,jsonb_array_length(p.preview->'employees') as count
   from jsonb_array_elements(${JSON.stringify(result.refs)}::jsonb) with ordinality r(ref,ord)
   join payroll_tax_basis_preview p on p.id=(r.ref->>'previewId')::uuid
     and p.preview_hash=r.ref->>'previewHash' and p.company_id=(r.ref->>'companyId')::uuid
   where p.tenant_id=${ctx.tenantId}::uuid and p.created_by=${ctx.userId??null}::uuid
     and p.company_id=any(${ids(job.company_ids)})
   order by r.ord`);
 const settings=new Map<string,string>();
 for(const {preview} of rows){
  const previous=settings.get(preview.companyId);
  if(previous&&previous!==preview.settingsHash)throw new PayrollTaxBasisError('Pay Item settings changed while the preview was running. Generate a fresh preview.');
  settings.set(preview.companyId,preview.settingsHash);
 }
 if(rows.length!==result.refs.length||new Set(result.refs.map(ref=>ref.previewId)).size!==rows.length||
    settings.size!==job.company_ids.length)throw unavailable();
 const expiresAt=new Date(new Date(job.finished_at??job.updated_at).getTime()+15*60_000);
 return {job,rows,expiresAt};
}

export async function requestTaxBasisGroupPreview(ctx:SessionContext,selections:TaxBasisSelection[],operationKey:string){
 validateSelections(selections);
 const requested=selections.map(s=>s.companyId);
 return withTenant(ctx,async tx=>{
  await checkCompanies(tx,ctx,requested);
  const {row}=await enqueueBulkJobTx(tx,ctx,{kind:KIND,companyIds:requested,operationKey,input:{selections} satisfies Input});
  return row.id;
 });
}

export async function requestTaxBasisGroupConfirmation(ctx:SessionContext,id:string){
 if(!validId(id))throw unavailable();
 return withTenant(ctx,async tx=>{
  const existing=await tx.execute<{id:string;companyIds:string[]}>(sql`
   select id,company_ids as "companyIds" from bulk_job where kind=${KIND} and operation_key=${id}::uuid
    and created_by=${ctx.userId??null}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if(existing[0]){await checkCompanies(tx,ctx,existing[0].companyIds);return existing[0].id;}
  const {job,rows,expiresAt}=await reviewedTx(tx,ctx,id);
  if(expiresAt.getTime()<Date.now()||!rows.some(row=>row.preview.eligibleCount))throw unavailable();
  const {row}=await enqueueBulkJobTx(tx,ctx,{kind:KIND,companyIds:job.company_ids,operationKey:id,input:{previewJobId:id} satisfies Input});
  return row.id;
 });
}

export async function readTaxBasisGroupProgress(ctx:SessionContext,id:string,offset=0){
 if(!validId(id)||!Number.isSafeInteger(offset)||offset<0||offset>=500_000)throw unavailable();
 return withTenant(ctx,async tx=>{
  const job=await bulkJobTx(tx,id,{kind:KIND});
  await checkCompanies(tx,ctx,job.company_ids);
  const progress={...bulkJobProgress(job),result:null};
  if(job.state!=='completed'){
   if(job.state==='failed'||job.state==='cancelled')return {progress};
   // a16382b4 — employee-level counts from the work actually recorded, never an estimate. A preview step owns
   // its employee chunk (planTaxBasisPreviewTx) and is done once applied; a confirmation step owns the reviewed
   // preview's eligible employees, each done once its batch records employee_completed or employee_failed.
   // One set-based statement over this job's steps; bounded by the job's companies (at most 500).
   const companies=await tx.execute<CompanyProgress>(sql`
    select c.id as "companyId",c.legal_name as name,case
     when progress.failed then 'failed'
     when progress.done then 'completed'
     when progress.started then 'processing'
     else 'pending' end as state,
     coalesce(progress.total,0)::integer as total,coalesce(progress.processed,0)::integer as processed,
     coalesce(progress.failures,0)::integer as failures
    from company c cross join lateral (
     select bool_or(s.state='failed') as failed,
      bool_and(s.state='applied' and (s.result->>'id' is null or exists(
       select 1 from payroll_tax_basis_event e where e.batch_id=(s.result->>'id')::uuid
        and e.kind in ('completed','completed_with_errors','failed')
      ))) as done, bool_or(s.state='applied') as started,
      sum(case when s.kind='preview' then jsonb_array_length(coalesce(s.payload->'employmentIds','[]'::jsonb))
       else coalesce((select (p.preview->>'eligibleCount')::integer from payroll_tax_basis_preview p
        where p.id=(s.payload->>'previewId')::uuid and p.company_id=c.id),0) end) as total,
      sum(case when s.kind='preview' then case when s.state='applied' then jsonb_array_length(coalesce(s.payload->'employmentIds','[]'::jsonb)) else 0 end
       else coalesce(outcome.processed,0) end) as processed,
      sum(coalesce(outcome.failures,0)) as failures
     from bulk_job_step s left join lateral (
      select count(distinct e.employment_id) as processed,
       count(distinct e.employment_id) filter (where e.kind='employee_failed') as failures
      from payroll_tax_basis_event e
      where s.kind='confirm' and e.batch_id=(s.result->>'id')::uuid and e.kind in ('employee_completed','employee_failed')
     ) outcome on true
     where s.job_id=${id}::uuid and (s.payload->>'companyId')::uuid=c.id
    ) progress
    where c.tenant_id=${ctx.tenantId}::uuid and c.id=any(${ids(job.company_ids)})
    order by c.legal_name,c.id`);
   const total=companies.reduce((n,c)=>n+c.total,0),processed=companies.reduce((n,c)=>n+c.processed,0),failures=companies.reduce((n,c)=>n+c.failures,0);
   return {progress,companies:[...companies],counts:{processed,total,failures}};
  }
  const result=job.result as GroupResult|null;
  if(result?.phase==='preview'){
   if(job.counters.failed)return {progress};
   const {rows,expiresAt}=await reviewedTx(tx,ctx,id);
   const totalEmployees=rows.reduce((total,row)=>total+row.count,0);
   const end=offset+TAX_BASIS_GROUP_PAGE_SIZE;
   let from=0;
   const ranges:{previewId:string;companyId:string;companyName:string;ord:number;first:number;last:number}[]=[];
   for(const {preview,count} of rows){
    const to=from+count;
    if(to>offset&&from<end)ranges.push({previewId:preview.previewId,companyId:preview.companyId,companyName:preview.companyName,
     ord:from,first:Math.max(0,offset-from),last:Math.min(count,end-from)-1});
    from=to;
   }
   const page=ranges.length?await tx.execute<{employee:TaxBasisEmployee;companyId:string;companyName:string}>(sql`
    select p.preview->'employees'->n.index as employee,r."companyId",r."companyName"
     from jsonb_to_recordset(${JSON.stringify(ranges)}::jsonb)
       as r("previewId" uuid,"companyId" uuid,"companyName" text,ord int,first int,last int)
     join payroll_tax_basis_preview p on p.id=r."previewId" and p.company_id=r."companyId"
     cross join lateral generate_series(r.first,r.last) n(index) order by r.ord,n.index`):[];
   return {progress,previews:rows.map(({preview})=>({...preview,expiresAt:expiresAt.toISOString()})),totalEmployees,
    employees:page.map(row=>({...row.employee,companyId:row.companyId,companyName:row.companyName}))};
  }
  if(result?.phase!=='confirmation')throw unavailable();
  const companies=await tx.execute<{id:string;name:string}>(sql`select id,legal_name as name
   from company where tenant_id=${ctx.tenantId}::uuid and id=any(${ids(job.company_ids)})`);
  const names=new Map(companies.map(company=>[company.id,company.name]));
  return {progress,batches:result.outcomes.map(outcome=>({...outcome,companyName:names.get(outcome.companyId)??''}))};
 });
}

/** a16382b4 — companies of the caller's own active grouped confirmations that the worker has not reached yet. Bulk
 * jobs are readable only by their submitter (bulk_job_read), so other operators see the run once its first batch for a
 * company exists. Companies whose reviewed previews have no eligible employee never get a batch and are not listed.
 * One set-based statement, bounded to 500 rows. */
export async function listQueuedTaxBasisRuns(ctx:SessionContext):Promise<TaxBasisHistoryRow[]>{
 assertModuleGate(ctx,'payroll');
 if(!ctx.userId)return [];
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{runId:string;companyId:string;companyName:string;createdAt:string;actorName:string;year:number|null;upToMonth:number|null;employeeCount:number;notIncluded:number}>(sql`
   select j.id as "runId",c.id as "companyId",c.legal_name as "companyName",j.created_at::text as "createdAt",
    coalesce(actor.full_name,j.created_by::text) as "actorName",pv.year,pv.up_to_month as "upToMonth",
    pv.employee_count::integer as "employeeCount",pv.not_included::integer as "notIncluded"
   from bulk_job j
   cross join lateral unnest(j.company_ids) as jc(company_id)
   join company c on c.id=jc.company_id and c.tenant_id=j.tenant_id
   join bulk_job pj on pj.id=(j.input->>'previewJobId')::uuid and pj.kind=${KIND}
   cross join lateral (
    select min((p.preview->>'year')::integer) as year,min((p.preview->>'upToMonth')::integer) as up_to_month,
     coalesce(sum((p.preview->>'eligibleCount')::integer),0) as employee_count,
     coalesce(sum(coalesce((p.preview->>'skippedCount')::integer,0)+coalesce((p.preview->>'blockedCount')::integer,0)+coalesce((p.preview->>'unchangedCount')::integer,0)),0) as not_included
    from jsonb_array_elements(coalesce(pj.result->'refs','[]'::jsonb)) r(ref)
    join payroll_tax_basis_preview p on p.id=(r.ref->>'previewId')::uuid and p.company_id=c.id and p.tenant_id=j.tenant_id
   ) pv
   left join app_user u on u.id=j.created_by left join person actor on actor.id=u.person_id
   where j.tenant_id=${ctx.tenantId}::uuid and j.created_by=${ctx.userId}::uuid and j.kind=${KIND} and j.input->>'previewJobId' is not null
    and j.state in ('queued','preparing','running','finalizing') and pv.employee_count>0
    and app.payroll_tax_basis_permission(c.id,'payroll.tax-basis.view')
    and not exists(select 1 from payroll_tax_basis_batch b where b.tenant_id=j.tenant_id and b.run_id=j.id and b.company_id=c.id)
   order by j.created_at desc,c.legal_name,c.id limit 500`);
  return rows.map(row=>({
   id:'queued:'+row.runId+':'+row.companyId,kind:'queued' as const,reference:null,companyId:row.companyId,companyName:row.companyName,
   year:row.year,upToMonth:row.upToMonth,status:'pending' as const,createdAt:row.createdAt,completedAt:null,actorName:row.actorName,
   employeeCount:row.employeeCount,processedCount:0,completedCount:0,failedCount:0,notIncludedCount:row.notIncluded,interrupted:false,batches:[],
  }));
 },{readOnlySnapshot:true});
}

export const taxBasisGroupJobHandler:BulkJobPreparedStepHandler<Step>={
 kind:KIND,
 mode:'per-step',
 quietNotice:()=>true,
 stepRef:step=>step.payload.companyId,
 async prepare(ctx,job){
  const input=job.input as Input|null;
  if(!input)throw unavailable();
  return withTenant(ctx,async tx=>{
   await checkCompanies(tx,ctx,job.company_ids);
   if('selections' in input){
    validateSelections(input.selections);
    if(input.selections.length!==job.company_ids.length||input.selections.some(s=>!job.company_ids.includes(s.companyId)))throw unavailable();
    const steps:{kind:'preview';payload:Step}[]=[];
    for(const selection of input.selections){
     const chunks=await planTaxBasisPreviewTx(tx,selection,TAX_BASIS_PREVIEW_CHUNK_SIZE);
     const selectionMode=selection.employmentIds===null?'all':'selected';
     for(const chunk of chunks)steps.push({kind:'preview',payload:{...chunk,selectionMode}});
    }
    return {steps};
   }
   if(!validId(input.previewJobId)||job.operation_key!==input.previewJobId)throw unavailable();
   const {rows,job:previewJob,expiresAt}=await reviewedTx(tx,ctx,input.previewJobId);
   if(new Date(job.created_at)>expiresAt||previewJob.company_ids.length!==job.company_ids.length||
      previewJob.company_ids.some(id=>!job.company_ids.includes(id)))throw unavailable();
   return {steps:rows.map(({preview})=>({kind:'confirm',payload:{
    companyId:preview.companyId,previewId:preview.previewId,previewHash:preview.previewHash,
   } satisfies PreviewRef}))};
  });
 },
 async prepareStep(ctx,job,step){
  const selection=step.payload;
  if(step.kind==='preview'&&'year' in selection){
   const {selectionMode,...criteria}=selection;
   const preview=await calculateTaxBasisPreview(ctx,criteria,{allowEmptySelection:true});
   return async tx=>{
    await saveTaxBasisPreviewTx(tx,ctx,criteria,preview);
    return {result:{companyId:preview.companyId,previewId:preview.previewId,previewHash:preview.previewHash,selectionMode} satisfies PreviewRef};
   };
  }
  if(step.kind!=='confirm'||!('previewId' in selection))throw unavailable();
  const confirm=await prepareReviewedTaxBasisConfirmation(ctx,selection,job.id);
  return async tx=>{
   const result=await confirm(tx);
   return {result:{companyId:selection.companyId,id:result.id} satisfies BatchRef};
  };
 },
 async finalize(ctx,job){
  const rows=await withTenant(ctx,async tx=>{
   await checkCompanies(tx,ctx,job.company_ids);
   return tx.execute<{kind:string;companyId:string;ref:PreviewRef|null;batchId:string|null;pending:boolean;error:string|null}>(sql`
    select s.kind,s.payload->>'companyId' as "companyId",s.result as ref,s.error,s.result->>'id' as "batchId",
     s.state='applied' and s.result->>'id' is not null and not exists(
      select 1 from payroll_tax_basis_event e where e.batch_id=(s.result->>'id')::uuid
        and e.kind in ('completed','completed_with_errors','failed')
     ) as pending from bulk_job_step s where s.job_id=${job.id}::uuid order by s.seq`);
  });
  const next=rows.find(row=>row.pending);
  if(next?.batchId){await continueTaxBasisBatch(ctx,next.batchId,{budgetMs:15000});return 'more';}
  // The bulk kernel removes step payloads after completion. Retain only the authorized references.
  const result:GroupResult=rows[0]?.kind==='preview'
   ?{phase:'preview',refs:rows.flatMap(row=>row.ref?[row.ref]:[])}
   :{phase:'confirmation',outcomes:rows.map(row=>({companyId:row.companyId,id:row.batchId,error:row.error}))};
  return {result};
 },
};
