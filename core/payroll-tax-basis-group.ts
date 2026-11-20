import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertModuleGate} from './module-gate';
import {bulkJobProgress,bulkJobTx,enqueueBulkJobTx} from './bulk-job';
import type {BulkJobHandler} from './bulk-job-worker';
import {confirmTaxBasisRecalculation,continueTaxBasisBatch,previewTaxBasisRecalculation} from './payroll-tax-basis';
import {PayrollTaxBasisError,type TaxBasisPreview,type TaxBasisSelection} from '../lib/payroll-tax-basis';

const KIND='payroll_tax_basis_group';
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const ids=(values:readonly string[])=>sql`array[${sql.join(values.map(value=>sql`${value}::uuid`),sql`,`)}]::uuid[]`;
const unavailable=()=>new PayrollTaxBasisError('The selected companies or recalculation preview are unavailable.');
type PreviewRef={companyId:string;previewId:string;previewHash:string};
type BatchRef={companyId:string;id:string|null};
type Input={selections:TaxBasisSelection[]}|{previewJobId:string};
type Step=TaxBasisSelection|PreviewRef;

function validateSelections(selections:TaxBasisSelection[]){
 if(!Array.isArray(selections)||selections.length<2||selections.length>500)throw unavailable();
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
 if(job.state!=='completed'||job.result!=='preview'||job.counters.failed)throw unavailable();
 const rows=await tx.execute<{preview:TaxBasisPreview;expired:boolean}>(sql`
  select p.preview,p.expires_at<now() as expired from bulk_job_step s
   join payroll_tax_basis_preview p on p.id=(s.result->>'previewId')::uuid
     and p.preview_hash=s.result->>'previewHash' and p.company_id=(s.result->>'companyId')::uuid
   where s.job_id=${job.id}::uuid and s.kind='preview' and s.state='applied'
     and p.tenant_id=${ctx.tenantId}::uuid and p.created_by=${ctx.userId}::uuid
   order by s.seq`);
 if(rows.length!==job.company_ids.length)throw unavailable();
 return {job,rows};
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
    and created_by=${ctx.userId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if(existing[0]){await checkCompanies(tx,ctx,existing[0].companyIds);return existing[0].id;}
  const {job,rows}=await reviewedTx(tx,ctx,id);
  if(rows.some(row=>row.expired)||!rows.some(row=>row.preview.eligibleCount))throw unavailable();
  const {row}=await enqueueBulkJobTx(tx,ctx,{kind:KIND,companyIds:job.company_ids,operationKey:id,input:{previewJobId:id} satisfies Input});
  return row.id;
 });
}

export async function readTaxBasisGroupProgress(ctx:SessionContext,id:string){
 if(!validId(id))throw unavailable();
 return withTenant(ctx,async tx=>{
  const job=await bulkJobTx(tx,id,{kind:KIND});
  await checkCompanies(tx,ctx,job.company_ids);
  const progress=bulkJobProgress(job);
  if(job.state!=='completed')return {progress};
  if(job.result==='preview'){
   if(job.counters.failed)return {progress};
   const {rows}=await reviewedTx(tx,ctx,id);
   return {progress,previews:rows.map(row=>row.preview)};
  }
  const batches=await tx.execute<{companyId:string;companyName:string;id:string|null;error:string|null}>(sql`
   select c.id as "companyId",c.legal_name as "companyName",s.result->>'id' as id,s.error
   from bulk_job_step s join company c on c.id=(s.payload->>'companyId')::uuid
   where s.job_id=${id}::uuid and s.kind='confirm' order by s.seq`);
  return {progress,batches:[...batches]};
 });
}

export const taxBasisGroupJobHandler:BulkJobHandler<Step>={
 kind:KIND,
 mode:'per-step',
 maxStepsPerChunk:1,
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
    return {steps:input.selections.map(selection=>({kind:'preview',payload:selection}))};
   }
   if(!validId(input.previewJobId)||job.operation_key!==input.previewJobId)throw unavailable();
   const {rows,job:previewJob}=await reviewedTx(tx,ctx,input.previewJobId);
   if(rows.some(row=>row.expired)||previewJob.company_ids.length!==job.company_ids.length||
      previewJob.company_ids.some(id=>!job.company_ids.includes(id)))throw unavailable();
   return {steps:rows.map(({preview})=>({kind:'confirm',payload:{
    companyId:preview.companyId,previewId:preview.previewId,previewHash:preview.previewHash,
   } satisfies PreviewRef}))};
  });
 },
 async applyStepTx(_tx,ctx,_job,step){
  const selection=step.payload;
  if(step.kind==='preview'&&'year' in selection){
   const preview=await previewTaxBasisRecalculation(ctx,selection,{allowEmptySelection:true});
   return {result:{companyId:preview.companyId,previewId:preview.previewId,previewHash:preview.previewHash} satisfies PreviewRef};
  }
  if(step.kind!=='confirm'||!('previewId' in selection))throw unavailable();
  const result=await confirmTaxBasisRecalculation(ctx,selection,{defer:true});
  return {result:{companyId:selection.companyId,id:result.id} satisfies BatchRef};
 },
 async finalize(ctx,job){
  const rows=await withTenant(ctx,async tx=>{
   await checkCompanies(tx,ctx,job.company_ids);
   return tx.execute<{kind:string;batchId:string|null;pending:boolean}>(sql`
    select s.kind,s.result->>'id' as "batchId",s.state='applied' and s.result->>'id' is not null and not exists(
     select 1 from payroll_tax_basis_event e where e.batch_id=(s.result->>'id')::uuid
       and e.kind in ('completed','completed_with_errors','failed')
    ) as pending from bulk_job_step s where s.job_id=${job.id}::uuid order by s.seq`);
  });
  const next=rows.find(row=>row.pending);
  if(next?.batchId){await continueTaxBasisBatch(ctx,next.batchId,{budgetMs:15000});return 'more';}
  return {result:rows[0]?.kind==='preview'?'preview':'confirmation'};
 },
};
