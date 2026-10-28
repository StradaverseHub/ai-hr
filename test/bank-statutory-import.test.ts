/**
 * 0db97f14 — Bank & Statutory import: every editable tab setting, the merged writer (a partial file never
 * clears another statutory field), row errors that name the column, Import History with field-level
 * before/after, and the once-only Revert. Real database, real RLS, fictional fixtures.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {commitSectionImport,validateSectionImport} from '../core/import-sections';
import {commitBankStatutoryUpload} from '../core/bank-statutory-upload';
import {readBankStatutoryStateTx,bankStatutorySubjectTx} from '../core/bank-statutory-import';
import {getImportAttempt,importAttemptSource,importSourceHash,ImportHistoryError} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {importAttemptStatus} from '../lib/import-history';
import {bankStatutoryChoices,STATUTORY_WRITER_FIELDS} from '../lib/bank-statutory-import';
import {foreignColumns,sectionColumns,sectionTemplateColumns,UNSECTIONED_COLUMNS} from '../lib/import-sections';
import {IMPORT_COLUMNS} from '../lib/import-schema';
import {personnelColumnLabel} from '../lib/personnel-import-contract';
import {buildPersonnelCsv} from '../lib/personnel-csv';
import {parseCsvRecords} from '../lib/csv';
import {getTaxSelectionMY} from '../localization/my/tax-selection';
import {setOthersStatutoryMY} from '../localization/my/statutory';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,a:SessionContext;
const recs=(header:string,rows:string[])=>parseCsvRecords(`${header}\n${rows.join('\n')}`).records;
const WIDE=['full_name','email','department','hired_on','ic_number','basic_salary','employee_code','employment_type','bank_name','bank_account_no','epf_number','socso_number','tax_number','tax_category','num_children'];
async function seedEmployee(n:number,code:string,companyId=b.companyId,department='Finance'){
 const ic=`9${String(n).padStart(2,'0')}0101${String(n).padStart(2,'0')}5566`.slice(0,12);
 const r=await commitEmployeeImport(a,{companyId,records:recs(WIDE.join(','),[[`Statutory Subject ${n}`,`bs${n}@example.test`,department,'2026-01-05',ic,'5000',code,'full_time','Maybank',`51400011122${n}`,`EPF-${n}`,`SOC-${n}`,`TAX-${n}`,'2','3'].join(',')])});
 expect(r.imported,JSON.stringify(r.failed)).toBe(1);
 const[e]=await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,b.tenantId),eq(s.employment.employeeCode,code)));
 // Settings this file never names: zakat, TP3 and a custom holder must survive every partial import.
 await owner.db.update(s.employeeStatutoryMy).set({zakatActive:true,zakatMethod:'fixed',zakatFixed:'25.00',zakatState:'Selangor',tp3Year:2026,tp3PcbPaid:'120.00',enableCustomHolderName:true,customHolderName:'Holder Name',employerBearsTax:true,subjectToHrdf:true}).where(eq(s.employeeStatutoryMy.personId,e.personId));
 return e;
}
const statutoryRow=async(personId:string)=>(await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,personId)))[0];
/** A file exactly as the template downloads it: Personnel CSV frame, translated-English captions. */
const file=(columns:string[],rows:string[][])=>Buffer.from(buildPersonnelCsv('employee',[columns.map(c=>personnelColumnLabel(c,'employee')),...rows]));
const upload=(ctx:SessionContext,columns:string[],rows:string[][],name='bank-statutory.csv')=>commitBankStatutoryUpload(ctx,{name,content:file(columns,rows)});
const stateOf=(employmentId:string)=>withTenant(a,async tx=>(await readBankStatutoryStateTx(tx,a,(await bankStatutorySubjectTx(tx,employmentId))!)).state);
async function scopedAdmin(companyId:string,email:string):Promise<SessionContext>{
 const[p]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:`Scoped ${email}`,primaryEmail:email}).returning();const userId=await createAppUser(b.tenantId,p.id,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return{...a,userId,personId:p.id,grants:[{role:'hr_admin',companyId}]};
}

beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();a=adminCtx(b);});
afterAll(closeAll);

describe('0db97f14 · the Bank & Statutory template carries every editable tab setting',()=>{
 it('owns the formerly fenced columns and every statutory writer column, resolved by the registry',()=>{
  const owned=sectionColumns('bank_statutory');
  for(const c of ['eis_eligible','epf_citizenship','is_resident'])expect(UNSECTIONED_COLUMNS[c]).toBeUndefined();
  for(const c of ['eis_eligible','epf_citizenship','is_resident'])expect(owned).toContain(c);
  const template=sectionTemplateColumns('bank_statutory');
  expect(STATUTORY_WRITER_FIELDS.length).toBeGreaterThanOrEqual(31);
  for(const f of STATUTORY_WRITER_FIELDS)expect(template).toContain(f.import.column);
  for(const c of ['epf_category','socso_category','eis_category','subject_to_skbbk','subject_to_hrdf','tax_residency','tax_circumstance','disabled_individual','disabled_spouse','child_relief_mode','child_relief_under_18_full','employer_bears_tax','employer_bears_epf'])expect(template).toContain(c);
  // The legacy yes/no adapters are accepted, but the template offers only the canonical columns.
  expect(template).not.toContain('eis_eligible');expect(template).not.toContain('is_resident');
  // The create path is untouched until the "Everything" template adopts these columns (524303d9).
  expect([...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional]).not.toContain('socso_category');
  expect([...IMPORT_COLUMNS.optional]).toContain('epf_citizenship');
  // A Profile file carrying a statutory setting is refused and pointed at its section.
  expect(foreignColumns('profile',['employee_code','socso_category'])).toEqual(['socso_category']);
 });
 it('offers Yes/No for tick-boxes and the pack’s lists for categories, residency and HRDF',()=>{
  expect(bankStatutoryChoices('subject_to_skbbk').map(c=>c.value)).toEqual(['yes','no']);
  expect(bankStatutoryChoices('subject_to_hrdf').map(c=>c.value)).toEqual(['yes','no','default']);
  expect(bankStatutoryChoices('tax_residency').map(c=>c.value)).toEqual(['resident','non_resident','rep','knowledge_worker','c_suite']);
  expect(bankStatutoryChoices('tax_circumstance').map(c=>c.value)).toContain('spouse_working');
  expect(bankStatutoryChoices('socso_category').map(c=>c.value)).toEqual(['auto','first','second','none']);
  expect(bankStatutoryChoices('bank_name').length).toBeGreaterThan(5);
 });
});

describe('0db97f14 · the merged writer',()=>{
 it('a partial file changes only its own cell and leaves every other statutory field untouched',async()=>{
  const e=await seedEmployee(1,'BS001');
  const before=await statutoryRow(e.personId);
  const records=recs('employee_code,subject_to_skbbk',['BS001,Yes']);
  expect((await validateSectionImport(a,{section:'bank_statutory',records})).rows[0]).toMatchObject({verdict:'update',ok:true,changes:['subject_to_skbbk']});
  expect((await commitSectionImport(a,{section:'bank_statutory',records})).updated).toBe(1);
  const after=await statutoryRow(e.personId);
  expect(after.subjectToSkbbk).toBe(true);
  const strip=(r:typeof before)=>({...r,subjectToSkbbk:null,updatedAt:null});
  expect(strip(after)).toEqual(strip(before));
  // Spot-check the fields the full-row setter rewrites, independently of the comparison above.
  expect(after).toMatchObject({zakatActive:true,zakatFixed:'25.00',tp3Year:2026,tp3PcbPaid:'120.00',bankName:'Maybank',epfNumber:'EPF-1',taxNumber:'TAX-1',taxCategory:2,numChildren:3,customHolderName:'Holder Name',employerBearsTax:true,subjectToHrdf:true});
 });

 it('each new column round-trips to what the Bank & Statutory tab shows',async()=>{
  const e=await seedEmployee(2,'BS002');
  const columns=['employee_code','epf_citizenship','epf_category','epf_employee_rate','epf_employer_rate','employer_bears_epf','socso_category','eis_category','subject_to_skbbk','employer_bears_socso','employer_bears_eis','employer_bears_skbbk','subject_to_hrdf','tax_circumstance','tax_residency','disabled_individual','disabled_spouse','child_relief_mode','child_relief_under_18_full','child_relief_study_tertiary_half','employer_bears_tax'];
  const values=['BS002','pr','manual_percentage','15','16','Yes','second','none','Yes','yes','YES','no','No','spouse_working','knowledge_worker','Yes','yes','auto_table','2','1','No'];
  const result=await upload(a,columns,[values]);
  expect(result,JSON.stringify(result)).toMatchObject({updated:1,failed:[],fileErrors:[]});
  const row=await statutoryRow(e.personId);
  expect(row).toMatchObject({epfCitizenship:'pr',epfMode:'voluntary_excess',epfEmployeeRate:'0.1500',epfEmployerRate:'0.1600',employerBearsEpf:true,socsoCategory:'second',eisCategory:'none',eisEligible:false,subjectToSkbbk:true,employerBearsSocso:true,employerBearsEis:true,employerBearsSkbbk:false,subjectToHrdf:false,taxCircumstance:'spouse_working',taxCategory:3,disabledIndividual:true,disabledSpouse:true,childReliefMode:'auto_table',employerBearsTax:false});
  expect(row.childReliefTable).toMatchObject({under_18:{full:2},study_tertiary:{half:1}});
  const selection=await getTaxSelectionMY(a,e.id);
  expect(selection).toMatchObject({scheme:'knowledge_worker',transitionState:'resolved'});
  // The tab's own projection reads the same values back, so a re-upload of the same row is NO CHANGE.
  const state=await stateOf(e.id);
  columns.slice(1).forEach((c,i)=>expect([c,state[c]]).toEqual([c,{Yes:'yes',YES:'yes',No:'no'}[values[i+1]]??values[i+1]]));
  const again=await validateSectionImport(a,{section:'bank_statutory',records:[Object.fromEntries(columns.map((c,i)=>[c,values[i]]))]});
  expect(again.rows[0].verdict).toBe('skip');
  // Untouched by every write above: zakat, TP3 and the bank block.
  expect(row).toMatchObject({zakatActive:true,zakatFixed:'25.00',tp3Year:2026,bankName:'Maybank',customHolderName:'Holder Name'});
 });

 it('invalid Yes/No, category and EPF election values give row errors that name the column',async()=>{
  await seedEmployee(3,'BS003');
  const preview=await validateSectionImport(a,{section:'bank_statutory',records:[
   {employee_code:'BS003',subject_to_skbbk:'maybe',socso_category:'third',tax_residency:'',epf_category:'',epf_manual_reason:''},
  ]});
  expect(preview.rows[0].ok).toBe(false);
  expect(preview.rows[0].errors).toEqual(expect.arrayContaining(['Subject to SKBBK: use Yes or No','SOCSO category: use one of auto, first, second, none']));
  const epf=await validateSectionImport(a,{section:'bank_statutory',records:[{employee_code:'BS003',epf_category:'manual_both_amount',epf_employee_amount:'100',epf_employer_amount:'120'}]});
  expect(epf.rows[0].errors.join(' ')).toMatch(/^EPF Category: /);
  const dropped=await validateSectionImport(a,{section:'bank_statutory',records:[{employee_code:'BS003',epf_employee_rate:'15'}]});
  expect(dropped.rows[0].errors.join(' ')).toContain('Employee rate %: not used by EPF Category "auto"');
  const suite=await validateSectionImport(a,{section:'bank_statutory',records:[{employee_code:'BS003',tax_residency:'c_suite'}]});
  expect(suite.rows[0].errors.join(' ')).toContain('C-Suite needs EPF citizenship PR or non-citizen');
  // The legacy adapters map onto the canonical settings.
  const legacy=await validateSectionImport(a,{section:'bank_statutory',records:[{employee_code:'BS003',eis_eligible:'no',is_resident:'no',epf_citizenship:'non_citizen'}]});
  expect(legacy.fileErrors).toEqual([]);expect(legacy.rows[0]).toMatchObject({ok:true});
  expect(legacy.rows[0].changes).toEqual(expect.arrayContaining(['eis_category','tax_residency','epf_citizenship']));
 });
});

describe('0db97f14 · Import History and Revert',()=>{
 it('records the original file and each changed field from what to what, and reverts it',async()=>{
  const e=await seedEmployee(4,'BS004');
  const original=await stateOf(e.id);const rowBefore=await statutoryRow(e.personId);
  const columns=['employee_code','socso_category','employer_bears_eis','tax_number'],rows=[['BS004','first','Yes','TAX-NEW'],['NOBODY','first','','']];
  const result=await upload(a,columns,rows,'statutory-april.csv');
  expect(result).toMatchObject({updated:1,fileErrors:[]});
  const detail=(await getImportAttempt(a,result.attemptId!))!;
  expect(detail.kind).toBe('bank_statutory');expect(importAttemptStatus(detail.plan,detail.events)).toBe('partial');
  expect(detail.plan.issues.map(i=>i.reason).join(' ')).toContain('NOBODY');
  const applied=detail.items.filter(i=>i.status==='applied');
  expect(applied).toHaveLength(1);
  expect(applied[0].before).toEqual({employeeCode:'BS004',fields:{employer_bears_eis:'no',socso_category:'auto',tax_number:'TAX-4'}});
  expect(applied[0].after).toEqual({employeeCode:'BS004',fields:{employer_bears_eis:'yes',socso_category:'first',tax_number:'TAX-NEW'}});
  const source=await importAttemptSource(a,result.attemptId!);
  expect(source?.content.equals(file(columns,rows))).toBe(true);expect(source?.sourceHash).toBe(importSourceHash(file(columns,rows)));
  // The existing run list keeps its row.
  expect((await owner.db.select().from(s.employeeImportRun).where(and(eq(s.employeeImportRun.tenantId,b.tenantId),eq(s.employeeImportRun.fileName,'statutory-april.csv')))).map(r=>r.importedRows)).toEqual([1]);

  const preview=await previewImportRevertForAttempt(a,result.attemptId!);
  expect(preview).toMatchObject({eligible:true,blockers:[]});
  expect(preview.items[0].restore).toEqual({fields:expect.arrayContaining([{field:'SOCSO category',value:'auto'}])});
  await revertImportForAttempt(a,result.attemptId!,{previewHash:preview.previewHash,reason:'Wrong month file'});
  expect(await stateOf(e.id)).toEqual(original);
  const rowAfter=await statutoryRow(e.personId);expect({...rowAfter,updatedAt:null}).toEqual({...rowBefore,updatedAt:null});
  const reverted=(await getImportAttempt(a,result.attemptId!))!;expect(importAttemptStatus(reverted.plan,reverted.events)).toBe('reverted');
  // Once only.
  await expect(previewImportRevertForAttempt(a,result.attemptId!)).rejects.toThrow('already been reverted');
  await expect(revertImportForAttempt(a,result.attemptId!,{previewHash:preview.previewHash,reason:'Again'})).rejects.toThrow('already been reverted');
 });

 it('refuses the whole revert after a later profile edit of a field the import set, and names it',async()=>{
  const e=await seedEmployee(5,'BS005');const e2=await seedEmployee(6,'BS006');
  const result=await upload(a,['employee_code','subject_to_hrdf','disabled_individual'],[['BS005','No','Yes'],['BS006','Default','']]);
  expect(result.updated).toBe(2);
  // Somebody saves the Others Statutory card afterwards.
  await setOthersStatutoryMY(a,{personId:e.personId,subjectToHrdf:true});
  const preview=await previewImportRevertForAttempt(a,result.attemptId!);
  expect(preview.eligible).toBe(false);
  expect(preview.blockers).toEqual([expect.objectContaining({label:expect.stringContaining('BS005'),reason:expect.stringContaining('Subject to HRDF has been changed since this import')})]);
  await expect(revertImportForAttempt(a,result.attemptId!,{previewHash:preview.previewHash,reason:'Undo it'})).rejects.toBeInstanceOf(ImportHistoryError);
  // All or nothing: the other employee keeps what the import set.
  expect((await statutoryRow(e2.personId)).subjectToHrdf).toBeNull();
  expect((await statutoryRow(e.personId)).disabledIndividual).toBe(true);
 });

 it('an administrator of another company can neither see nor revert the import',async()=>{
  await seedEmployee(7,'BS007');
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',country:'MY'}).returning();
  const betaOnly=await scopedAdmin(beta.id,'beta-statutory@example.test');
  const result=await upload(a,['employee_code','employer_bears_tax'],[['BS007','No']]);
  expect(result.updated).toBe(1);
  expect(await getImportAttempt(betaOnly,result.attemptId!)).toBeNull();
  await expect(previewImportRevertForAttempt(betaOnly,result.attemptId!)).rejects.toThrow();
  // And their own upload naming the other company's employee writes nothing.
  const theirs=await upload(betaOnly,['employee_code','employer_bears_tax'],[['BS007','Yes']]);
  expect(theirs.updated).toBe(0);
 });
});
