/**
 * Bank & Statutory validation reads income tax residency for the whole batch at once (14 Nov 2026,
 * deploy/systemd/BANK-IMPORT.md "Stall watchdog"). Each per-row read rebuilt the tenant's visible-employment set
 * in the employment row policy, so a 1,000-row validation tick in a 250,001-employee tenant ran about 790 s.
 * (1) The set-wise read answers exactly what the per-row `readTaxResidencyTx` answers, for every residency state,
 *     a missing statutory record, another company's employee and weaker principals, in the same transaction.
 * (2) A 1,000-row validation tick issues a fixed number of residency statements, the same as a 10-row batch.
 * Real database, real row security, fictional fixtures.
 */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {analyzeBankImportBatch,validateSectionImport} from '../core/import-sections';
import {readTaxResidenciesTx,readTaxResidencyTx,type BankStatutorySubject} from '../core/bank-statutory-import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {runBankImportTick} from '../core/bank-import-worker';
import {BANK_IMPORT_CHUNK_BYTES,BANK_IMPORT_VALIDATION_ROWS} from '../lib/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import {requirePackFor} from '../localization/registry';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,a:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();a=adminCtx(b);});
afterEach(()=>{vi.restoreAllMocks();});
afterAll(closeAll);

const MY=requirePackFor('MY');
const recs=(header:string,rows:string[])=>parseCsvRecords(`${header}\n${rows.join('\n')}`).records;
async function hire(n:number,code:string,companyId=b.companyId){
 const ic=`8${String(n).padStart(2,'0')}0101${String(n).padStart(2,'0')}4433`.slice(0,12);
 const r=await commitEmployeeImport(a,{companyId,records:recs('full_name,email,department,hired_on,ic_number,basic_salary,employee_code',[`Residency Subject ${n},rs${n}@example.test,Finance,2026-01-05,${ic},5000,${code}`])});
 expect(r.imported,JSON.stringify(r.failed)).toBe(1);
 const[e]=await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,b.tenantId),eq(s.employment.employeeCode,code)));
 return e;
}
/** The employment's own selection for `companyId`, replacing whatever hiring created. */
async function select(employmentId:string,companyId:string,p:{scheme:'resident'|'non_resident'|'rep'|'knowledge_worker'|'c_suite'|null;state:'resolved'|'confirmation_required';epoch?:number}|null){
 await owner.db.delete(s.employmentTaxSelectionMy).where(eq(s.employmentTaxSelectionMy.employmentId,employmentId));
 if(p)await owner.db.insert(s.employmentTaxSelectionMy).values({tenantId:b.tenantId,employmentId,companyId,scheme:p.scheme,transitionState:p.state,taxApplicabilityEpoch:p.epoch??0,source:'explicit',provenance:{reason:'fixture',declarationIds:[]},updatedByUserId:b.adminUserId});
}
const circumstance=(personId:string,taxCircumstance:'single'|'spouse_not_working'|'spouse_working'|'widow_divorced'|'none'|null,taxCategory:number,taxApplicabilityEpoch=0)=>
 owner.db.update(s.employeeStatutoryMy).set({taxCircumstance,taxCategory,taxApplicabilityEpoch}).where(eq(s.employeeStatutoryMy.personId,personId));
async function scopedAdmin(companyId:string,email:string):Promise<SessionContext>{
 const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:`Scoped ${email}`,primaryEmail:email}).returning();const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return{...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId}]};
}

/** Wraps the pack's set-wise read so the test counts the statements it builds on the caller's transaction. */
function countResidencyReads(){
 const counts={single:0,setWise:0,statements:0,ids:[] as number[]};
 const originalMany=MY.statutory.getTaxSelections!,originalSingle=MY.statutory.getTaxSelection!;
 vi.spyOn(MY.statutory,'getTaxSelection').mockImplementation((...args)=>{counts.single++;return originalSingle(...args);});
 vi.spyOn(MY.statutory,'getTaxSelections').mockImplementation((ctx,ids,options)=>{
  counts.setWise++;counts.ids.push(ids.length);
  const tx=new Proxy(options.tx,{get(target,key,receiver){
   const value=Reflect.get(target,key,receiver);
   if(key==='select'||key==='execute')return(...args:unknown[])=>{counts.statements++;return(value as (...x:unknown[])=>unknown).apply(target,args);};
   return typeof value==='function'?value.bind(target):value;
  }}) as Tx;
  return originalMany(ctx,ids,{...options,tx});
 });
 return counts;
}

describe('Bank & Statutory validation reads tax residency set-wise',()=>{
 it('answers exactly what the per-row read answers, for every residency state and principal',async()=>{
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',country:'MY'}).returning();
  await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:beta.id,name:'Finance'});
  const fixtures:{code:string;expected:string;arrange:(e:typeof s.employment.$inferSelect)=>Promise<unknown>;companyId?:string}[]=[
   {code:'RS01',expected:'resident',arrange:e=>select(e.id,b.companyId,{scheme:'resident',state:'resolved'})},
   {code:'RS02',expected:'non_resident',arrange:e=>select(e.id,b.companyId,{scheme:'non_resident',state:'resolved'})},
   {code:'RS03',expected:'rep',arrange:e=>select(e.id,b.companyId,{scheme:'rep',state:'resolved'})},
   {code:'RS04',expected:'knowledge_worker',arrange:e=>select(e.id,b.companyId,{scheme:'knowledge_worker',state:'resolved'})},
   {code:'RS05',expected:'c_suite',arrange:e=>select(e.id,b.companyId,{scheme:'c_suite',state:'resolved'})},
   {code:'RS06',expected:'none',arrange:async e=>{await circumstance(e.personId,'none',1,1);await select(e.id,b.companyId,{scheme:'resident',state:'resolved'});}},
   {code:'RS07',expected:'',arrange:e=>select(e.id,b.companyId,{scheme:'resident',state:'confirmation_required'})},
   {code:'RS08',expected:'',arrange:e=>select(e.id,b.companyId,null)},
   // The person's applicability epoch moved on after the selection was resolved: confirmation is required.
   {code:'RS09',expected:'',arrange:async e=>{await circumstance(e.personId,'single',1,2);await select(e.id,b.companyId,{scheme:'resident',state:'resolved',epoch:0});}},
   // Only a selection for another employer: the current company has none.
   {code:'RS10',expected:'',arrange:e=>select(e.id,beta.id,{scheme:'non_resident',state:'resolved'})},
   {code:'RS11',expected:'resident',arrange:async e=>{await circumstance(e.personId,'single',1);await select(e.id,b.companyId,{scheme:'resident',state:'resolved'});}},
   {code:'RS12',expected:'non_resident',arrange:async e=>{await circumstance(e.personId,'spouse_not_working',2);await select(e.id,b.companyId,{scheme:'non_resident',state:'resolved'});}},
   {code:'RS13',expected:'knowledge_worker',arrange:async e=>{await circumstance(e.personId,'spouse_working',3);await select(e.id,b.companyId,{scheme:'knowledge_worker',state:'resolved'});}},
   {code:'RS14',expected:'rep',arrange:async e=>{await circumstance(e.personId,'widow_divorced',3);await select(e.id,b.companyId,{scheme:'rep',state:'resolved'});}},
   {code:'RS15',expected:'',arrange:async e=>{await circumstance(e.personId,null,1);await select(e.id,b.companyId,{scheme:null,state:'confirmation_required'});}},
   // An employee of the second company, read by an administrator of both and by one of each company.
   {code:'RS16',expected:'resident',companyId:beta.id,arrange:e=>select(e.id,beta.id,{scheme:'resident',state:'resolved'})},
  ];
  const items:{code:string;expected:string;subject:BankStatutorySubject;row:{taxCircumstance?:string|null}|null}[]=[];
  for(const[index,f]of fixtures.entries()){
   const e=await hire(index+1,f.code,f.companyId);await f.arrange(e);
   const[row]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,e.personId));
   expect(row,f.code).toBeTruthy();
   items.push({code:f.code,expected:f.expected,subject:{employmentId:e.id,personId:e.personId,pack:MY,country:'MY'},row});
  }
  // No statutory record at all (an employment created without one).
  const[bare]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Residency Bare',primaryEmail:'rs-bare@example.test'}).returning();
  const[bareEmployment]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:bare.id,companyId:b.companyId,employeeCode:'RS17',hiredOn:'2026-01-05'}).returning();
  await owner.db.delete(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,bare.id));
  items.push({code:'RS17',expected:'',subject:{employmentId:bareEmployment.id,personId:bare.id,pack:MY,country:'MY'},row:null});
  // The statutory record is present in the caller's row but gone from the database: the pack read finds no profile.
  const gone=await hire(18,'RS18');await select(gone.id,b.companyId,{scheme:'non_resident',state:'resolved'});
  const[goneRow]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,gone.personId));
  await owner.db.delete(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,gone.personId));
  items.push({code:'RS18',expected:'non_resident',subject:{employmentId:gone.id,personId:gone.personId,pack:MY,country:'MY'},row:goneRow});
  // A subject named twice in one batch answers twice.
  items.push({...items[1]});

  const acmeOnly=await scopedAdmin(b.companyId,'rs-acme@example.test'),betaOnly=await scopedAdmin(beta.id,'rs-beta@example.test');
  const selfUser=await createAppUser(b.tenantId,items[0].subject.personId,'employee');
  const self:SessionContext={tenantId:b.tenantId,userId:selfUser,roles:['employee'],entitlements:a.entitlements};
  const noGrant:SessionContext={...a,roles:[],grants:[]};
  const compare=(ctx:SessionContext)=>withTenant(ctx,async tx=>{
   const single:string[]=[];for(const item of items)single.push(await readTaxResidencyTx(tx,ctx,item.subject,item.row));
   const batch=await readTaxResidenciesTx(tx,ctx,items);
   return{single,batch};
  });
  const answers:Record<string,{single:string[];batch:string[]}>={};
  for(const[name,ctx]of Object.entries({admin:a,acmeOnly,betaOnly,self,noGrant}))answers[name]=await compare(ctx);
  for(const[name,{single,batch}]of Object.entries(answers))expect([name,batch]).toEqual([name,single]);
  // Independent expectations, so equality is not vacuous: the full administrator sees every state…
  expect(answers.admin.batch).toEqual(items.map(item=>item.expected));
  expect(new Set(answers.admin.batch)).toEqual(new Set(['resident','non_resident','rep','knowledge_worker','c_suite','none','']));
  // …a single-company administrator sees only their own company's employees (None is the person's own circumstance,
  // already in the caller's row)…
  const acmeExpected=items.map(item=>item.code==='RS16'?'':item.expected);
  expect(answers.acmeOnly.batch).toEqual(acmeExpected);
  expect(answers.betaOnly.batch).toEqual(items.map(item=>item.code==='RS16'?'resident':item.expected==='none'?'none':''));
  // …and an employee or a principal without grants never reads a selection.
  for(const name of ['self','noGrant'])expect(answers[name].batch).toEqual(items.map(item=>item.expected==='none'?'none':''));

  // The same file validated as one batch and row by row gives the same rows.
  const records=items.filter(item=>!['RS17','RS18'].includes(item.code)).slice(0,fixtures.length).map(item=>({employee_code:item.code,tax_residency:'non_resident'}));
  const pick=(row:{verdict?:unknown;ok?:unknown;changes?:unknown;errors?:unknown})=>({verdict:row.verdict,ok:row.ok,changes:row.changes,errors:row.errors});
  const whole=await validateSectionImport(a,{section:'bank_statutory',records});
  expect(whole.rows).toHaveLength(records.length);
  for(const[index,record]of records.entries()){
   const alone=await validateSectionImport(a,{section:'bank_statutory',records:[record]});
   expect([record.employee_code,pick(alone.rows[0])]).toEqual([record.employee_code,pick(whole.rows[index])]);
  }
  // A resolved non-resident is unchanged; a resolved other scheme is a change.
  expect(pick(whole.rows[records.findIndex(r=>r.employee_code==='RS02')]).changes).not.toContain('tax_residency');
  expect(pick(whole.rows[records.findIndex(r=>r.employee_code==='RS01')]).changes).toContain('tax_residency');
 },120_000);

 // TEMPORARY 400 s while the phases are timed on a runner (the first run exceeded 120 s); set to ~3x the measured worst.
 it('a 1,000-row validation tick issues the same fixed number of residency statements as a 10-row batch',async()=>{
  const started=Date.now(),mark=(label:string)=>console.info(`[bank-residency-batch] ${label}: ${((Date.now()-started)/1000).toFixed(1)} s`);
  const template=await hire(1,'RSTPL');
  const ROWS=BANK_IMPORT_VALIDATION_ROWS;
  expect(ROWS).toBe(1000);
  await owner.client.begin(async fixture=>{
   await fixture`set local session_replication_role='replica'`;
   await fixture`with people as (
    insert into person(tenant_id,full_name,primary_email)
    select ${b.tenantId}::uuid,'Residency Batch '||n,'rsb'||n||'@example.test' from generate_series(1,${ROWS}::int) n returning id,full_name
   ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
    select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'RSB'||substring(full_name from 17),'2026-01-05'::date from people`;
   await fixture`insert into employee_statutory_my
    select replacement.* from employment e
    cross join lateral jsonb_populate_record(null::employee_statutory_my,
     (select to_jsonb(x) from employee_statutory_my x where x.person_id=${template.personId}::uuid)
     ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TRSB','epf_citizenship','pr')) replacement
    where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'RSB%'`;
   await fixture`insert into employment_tax_selection_my(tenant_id,employment_id,company_id,scheme,transition_state,source,provenance)
    select e.tenant_id,e.id,e.company_id,case when right(e.employee_code,1)='7' then 'non_resident' else 'resident' end,'resolved','explicit','{"reason":"fixture","declarationIds":[]}'::jsonb
    from employment e where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'RSB%'`;
  });
  // Fresh statistics, as an installation's autovacuum keeps them: without them app.bank_import_subjects plans the
  // 1,000-code lookup badly and runs for minutes on a runner (observed in run 43595728226).
  for(const table of ['person','employment','employee_statutory_my','employment_tax_selection_my'])await owner.client.unsafe(`analyze ${table}`);
  mark('fixture');
  const codes=Array.from({length:ROWS},(_,i)=>`RSB${i+1}`);
  const expected=await withTenant(a,async tx=>{
   const rows=await tx.select({id:s.employment.id,personId:s.employment.personId,code:s.employment.employeeCode}).from(s.employment).where(inArray(s.employment.employeeCode,codes.slice(0,10)));
   const out=new Map<string,string>();
   for(const row of rows){const[statutory]=await tx.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,row.personId));out.set(row.code!,await readTaxResidencyTx(tx,a,{employmentId:row.id,personId:row.personId,pack:MY,country:'MY'},statutory));}
   return out;
  });
  expect([...expected.values()].filter(Boolean)).toHaveLength(10);

  mark('per-row reference');
  // A 10-row batch: one set-wise read, nothing per row.
  const small=countResidencyReads();
  const ten=await analyzeBankImportBatch(a,codes.slice(0,10).map(code=>({employee_code:code,tax_residency:'non_resident',epf_citizenship:'pr'})));
  expect(ten.rows).toHaveLength(10);
  expect({single:small.single,setWise:small.setWise,ids:small.ids}).toEqual({single:0,setWise:1,ids:[10]});
  const tenStatements=small.statements;
  expect(tenStatements).toBeGreaterThan(0);expect(tenStatements).toBeLessThanOrEqual(6);
  // A row whose stored residency equals the file's is unchanged; another needs the change. The batch read decides it.
  for(const[index,row]of ten.rows.entries())expect([codes[index],row.preview.changes?.includes('tax_residency')]).toEqual([codes[index],expected.get(codes[index])!=='non_resident']);
  vi.restoreAllMocks();

  // The worker's real validation tick over 1,000 rows naming residency columns.
  const csv=Buffer.from('employee_code,tax_residency,epf_citizenship\n'+codes.map(code=>`${code},non_resident,pr`).join('\n'));
  const admission=await createBankImportJob(a,{name:'residency.csv',bytes:csv.length,hash:createHash('sha256').update(csv).digest('hex')});
  for(let offset=0,part=0;offset<csv.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(a,admission.job.id,part,csv.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
  await bankImportCommand(a,admission.job.id,'validate');
  mark('10-row batch');
  expect(await runBankImportTick(owner.client)).toBe(true);
  mark('queued tick');
  expect((await getBankImportJob(a,admission.job.id)).job).toMatchObject({state:'validating',total:ROWS});
  const large=countResidencyReads();
  // Diagnostic while the tick runs: any session of this database waiting longer than 20 s is printed.
  const watch=setInterval(()=>{void owner.client`select pid,state,wait_event_type,wait_event,left(query,160) as query,now()-query_start as running from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state<>'idle' and now()-query_start>interval '20 seconds'`.then(rows=>{if(rows.length)console.info(`[bank-residency-batch] waiting: ${JSON.stringify(rows)}`);},()=>{});},20_000);
  try{expect(await runBankImportTick(owner.client)).toBe(true);}finally{clearInterval(watch);}
  mark('validation tick');
  const{job}=await getBankImportJob(a,admission.job.id);
  expect(job.validated).toBe(ROWS);
  expect({single:large.single,setWise:large.setWise,ids:large.ids}).toEqual({single:0,setWise:1,ids:[ROWS]});
  // The same statements for 1,000 rows as for 10: the count does not grow with the rows.
  expect(large.statements).toBe(tenStatements);
  // Every 7th-ending code is already non-resident, so it is unchanged; the rest are changes.
  const sevens=codes.filter(code=>code.endsWith('7')).length;
  expect({valid:job.valid,unchanged:job.unchanged,invalid:job.invalid}).toEqual({valid:ROWS-sevens,unchanged:sevens,invalid:0});
 },400_000);
});
