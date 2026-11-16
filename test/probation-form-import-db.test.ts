// Importing saved offline Probation Evaluation Forms (lane J, migration 5762; handoff §5 Part C items 1-2). One file per
// transaction, authorised by the existing intake authority (the employment's PBP/GBS reviewer). A matching case is merged
// into (blank drafts only, original file kept, case history written); an eligible employee without a case is staged for
// the reviewed cut-over; anything else is refused and writes nothing. Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationFormCaseFixture} from './helpers/probation-form-case-fixture';
import {withTenant,type SessionContext} from '../db/client';
import {importProbationSavedForm,previewProbationSavedForm,probationFormImports,readProbationFormImport} from '../packs/probation/service';

let b:Base,admin:SessionContext,forms:ReturnType<typeof probationFormCaseFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);forms=probationFormCaseFixture(b,admin);});

const code=async(employmentId:string)=>(await owner.db.execute<{code:string}>(sql`select employee_code as code from employment where id=${employmentId}::uuid`))[0].code;
/** A synthetic saved v22.9.26 form (field names inferred from the prototype) with the given values. */
function savedForm(f:Record<string,unknown>,locks:Record<string,boolean>={}){
 return Buffer.from('<!doctype html><html><body><h1>Probation Evaluation Form</h1><script id="form-data" type="application/json">'+JSON.stringify({formVersion:'22.9.26',meta:{savedAt:'2026-06-20T10:00:00+08:00'},f,locks}).replace(/<\//g,'<\\/')+'</script></body></html>','utf8');
}
const finalReview=(name:string,id:string,extra:Record<string,unknown>={})=>savedForm({emp_name:name,emp_id:id,
 p3_A1_r:'4',p3_A1_ev:'My own fictional evidence',p3_A1_mr:'3',p3_A1_mev:'Fictional manager evidence',p3_A2_mr:'4',p3_B1_mr:'5',
 p3_date:'2026-06-15',p3_strengths:'Fictional strengths',p3_decision:'confirm',p3_justify:'Fictional justification',...extra});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const rows=async(employmentId:string)=>[...await owner.db.execute<{result:string;case_id:string|null;file_name:string;content_hash:string;content:Buffer}>(sql`select result,case_id,file_name,content_hash,content from probation_form_import where employment_id=${employmentId}::uuid order by imported_at,id`)];
const draft=async(partId:string,rater:'employee'|'lm')=>(await owner.db.execute<{data:Record<string,unknown>}>(sql`select data from probation_rater_draft where part_id=${partId}::uuid and rater=${rater}`))[0].data;

describe('merge into the matching case',()=>{
 it('fills only blank drafts, keeps the original file with its hash, writes the case history, and is idempotent',async()=>{
  const c=await forms.caseWithRows([]);admin=c.admin;
  const id=await code(c.staff.employmentId),file=finalReview('Fictional Staff',id);
  const before=(await owner.db.execute<{revision:number}>(sql`select revision from probation_part where id=${c.ids.part}::uuid`))[0].revision;

  const preview=await previewProbationSavedForm(admin,{companyId:b.companyId,name:'staff-final.html',content:file});
  expect(preview).toMatchObject({result:'previewed',employee:{name:'Fictional Staff',id}});
  expect(await rows(c.staff.employmentId)).toEqual([]);

  const result=await importProbationSavedForm(admin,{companyId:b.companyId,name:'staff-final.html',content:file});
  expect(result).toMatchObject({result:'merged',caseId:c.ids.caseId});
  expect(result.parts?.find(p=>p.part===3)).toMatchObject({status:'started',applied:'draft_filled'});
  // The Line Manager's and the employee's drafts now hold the file's values; nothing was submitted or signed.
  const lm=await draft(c.ids.part,'lm') as {manager:Record<string,{rating:number|null;evidence:string}>;outcome:string;justification:string;strengths:string};
  expect(lm.manager.kpi).toEqual({rating:3,evidence:'Fictional manager evidence'});
  expect(lm.manager.knowledge.rating).toBe(4);expect(lm.manager.customer.rating).toBe(5);expect(lm.manager.action.rating).toBeNull();
  expect(lm).toMatchObject({outcome:'confirm',justification:'Fictional justification',strengths:'Fictional strengths'});
  const self=await draft(c.ids.part,'employee') as {employee:Record<string,{rating:number|null;evidence:string}>};
  expect(self.employee.kpi).toEqual({rating:4,evidence:'My own fictional evidence'});
  const[part]=await owner.db.execute<{revision:number;state:string;reviewOn:string;managerSubmittedAt:string|null}>(sql`select revision,data->>'state' as state,data->>'reviewOn' as "reviewOn",data->>'managerSubmittedAt' as "managerSubmittedAt" from probation_part where id=${c.ids.part}::uuid`);
  expect(part).toMatchObject({revision:before+1,state:'issued',reviewOn:'2026-06-15',managerSubmittedAt:null});
  // The original file is kept against the case, with its SHA-256, and the import is in the case history.
  const stored=await rows(c.staff.employmentId);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({result:'merged',case_id:c.ids.caseId,file_name:'staff-final.html',content_hash:sha(file)});
  expect(Buffer.from(stored[0].content).equals(file)).toBe(true);
  const original=await readProbationFormImport(admin,result.importId!);
  expect(original.name).toBe('staff-final.html');expect(Buffer.from(original.content).equals(file)).toBe(true);
  const[event]=await owner.db.execute<{payload:{importId:string;contentHash:string;fileName:string}}>(sql`select payload from domain_event where aggregate_id=${c.ids.caseId}::uuid and event_type='probation.html_form_imported'`);
  expect(event.payload).toMatchObject({importId:result.importId,contentHash:sha(file),fileName:'staff-final.html'});
  expect((await probationFormImports(admin,b.companyId)).map(r=>({id:r.id,result:r.result,caseId:r.caseId}))).toEqual([{id:result.importId,result:'merged',caseId:c.ids.caseId}]);

  // The same file again changes nothing.
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'copy.html',content:file})).toMatchObject({result:'unchanged',previous:'merged',importId:result.importId});
  expect(await rows(c.staff.employmentId)).toHaveLength(1);
  expect(await c.events('probation.html_form_imported')).toBe(1);
  expect((await owner.db.execute<{revision:number}>(sql`select revision from probation_part where id=${c.ids.part}::uuid`))[0].revision).toBe(before+1);

  // A different file never overwrites what is already in the system.
  const second=await importProbationSavedForm(admin,{companyId:b.companyId,name:'later.html',content:finalReview('Fictional Staff',id,{p3_A1_mr:'1',p3_A1_mev:'Different',p3_strengths:'Different'})});
  expect(second.parts?.find(p=>p.part===3)).toMatchObject({applied:'kept_system_values'});
  expect(((await draft(c.ids.part,'lm')) as {manager:Record<string,{rating:number}>}).manager.kpi.rating).toBe(3);
 });

 it('refuses a file naming someone else for the Employee ID, and an unknown Employee ID, writing nothing',async()=>{
  const c=await forms.caseWithRows([]);admin=c.admin;
  const id=await code(c.staff.employmentId);
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'wrong.html',content:finalReview('Fictional Someone Else',id)})).toMatchObject({result:'refused',code:'name_mismatch'});
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'unknown.html',content:finalReview('Fictional Staff','FX-NOT-HERE')})).toMatchObject({result:'refused',code:'no_employee'});
  expect(await rows(c.staff.employmentId)).toEqual([]);
  expect(await c.events('probation.html_form_imported')).toBe(0);
 });

 it('authorises on the server: an employee cannot import, even for their own Employee ID',async()=>{
  const c=await forms.caseWithRows([]);
  const id=await code(c.staff.employmentId),file=finalReview('Fictional Staff',id);
  await expect(importProbationSavedForm(c.staff.ctx,{companyId:b.companyId,name:'mine.html',content:file})).rejects.toThrow();
  // Called directly, the database function answers as if the employee were not there.
  const[direct]=await withTenant(c.staff.ctx,tx=>tx.execute<{data:{result:string;code:string}}>(sql`select app.probation_form_import(${b.companyId}::uuid,${id},'mine.html',${file},${JSON.stringify({formVersion:'22.9.26',employee:{name:'Fictional Staff',id},parts:{}})}::jsonb) as data`));
  expect(direct.data).toMatchObject({result:'refused',code:'no_employee'});
  expect(await rows(c.staff.employmentId)).toEqual([]);
 });
});

describe('no case yet',()=>{
 it('stages an eligible employee for the reviewed cut-over without opening a case, and refuses one who is not eligible',async()=>{
  const c=await forms.caseWithRows([]);admin=c.admin;
  // Intake for existing staff happens before the company is switched on.
  await owner.db.execute(sql`update probation_activation set enabled=false where tenant_id=${b.tenantId}::uuid`);
  const newcomer=await forms.person('Fictional Newcomer'),confirmed=await forms.person('Fictional Confirmed');
  await owner.db.execute(sql`update employment set confirmation_date='2026-03-01' where id=${confirmed.employmentId}::uuid`);
  const id=await code(newcomer.employmentId);
  const file=savedForm({emp_name:'Fictional Newcomer',emp_id:id,acc1_t:'Fictional accountability',acc1_k:'Fictional measure',acc1_g:'Fictional target',p1_emp_name:'Fictional Newcomer',p1_emp_date:'2026-01-09',p1_mgr_name:'Fictional Manager',p1_mgr_date:'2026-01-08'},{p1:true});
  const staged=await importProbationSavedForm(admin,{companyId:b.companyId,name:'newcomer.html',content:file});
  expect(staged).toMatchObject({result:'staged'});
  expect(staged.parts).toEqual([{part:1,status:'signed',applied:'staged'},{part:2,status:'not_started',applied:'staged'},{part:3,status:'not_started',applied:'staged'}]);
  expect(await rows(newcomer.employmentId)).toEqual([expect.objectContaining({result:'staged',case_id:null,content_hash:sha(file)})]);
  expect((await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_case where employment_id=${newcomer.employmentId}::uuid`))[0].n).toBe(0);
  expect((await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where subject_employment_id=${newcomer.employmentId}::uuid and event_type='probation.html_form_staged'`))[0].n).toBe(1);
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'again.html',content:file})).toMatchObject({result:'unchanged',previous:'staged'});
  expect((await probationFormImports(admin,b.companyId)).filter(r=>r.employmentId===newcomer.employmentId).map(r=>r.result)).toEqual(['staged']);

  const refused=await importProbationSavedForm(admin,{companyId:b.companyId,name:'confirmed.html',content:savedForm({emp_name:'Fictional Confirmed',emp_id:await code(confirmed.employmentId)})});
  expect(refused).toMatchObject({result:'refused',code:'excluded',reason:'confirmed'});
  expect(await rows(confirmed.employmentId)).toEqual([]);
 });

 it('leaves a new starter in a live company to open automatically',async()=>{
  const c=await forms.caseWithRows([]);admin=c.admin;
  const starter=await forms.person('Fictional Starter');
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'starter.html',content:savedForm({emp_name:'Fictional Starter',emp_id:await code(starter.employmentId)})})).toMatchObject({result:'refused',code:'opens_automatically'});
  expect(await rows(starter.employmentId)).toEqual([]);
 });

 it('refuses an unsupported version before touching the database',async()=>{
  const c=await forms.caseWithRows([]);admin=c.admin;
  const content=Buffer.from('<script id="form-data" type="application/json">'+JSON.stringify({formVersion:'23.1.0',f:{emp_name:'Fictional Staff',emp_id:await code(c.staff.employmentId)}})+'</script>');
  expect(await importProbationSavedForm(admin,{companyId:b.companyId,name:'new-version.html',content})).toMatchObject({result:'refused',code:'wrong_version',version:'23.1.0'});
  expect(await rows(c.staff.employmentId)).toEqual([]);
 });
});
