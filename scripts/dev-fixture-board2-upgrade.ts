/**
 * Populated, fictional upgrade witness. Copy this coordinator into the owned baseline checkout;
 * its relative imports then execute that checkout's kernel. Run `prepare` there before migration,
 * and `compare` from the candidate after migration. No reset/reseed and no real customer data.
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {todayInKualaLumpur} from '../lib/hr-date';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID} from '../db/seed-guard';

const phase=process.argv[2];
if(!['prepare','compare'].includes(phase)||process.env.NODE_ENV==='production')throw new Error('Choose prepare or compare in the isolated local upgrade database.');
for(const raw of [process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL]){
 const u=new URL(raw??'');
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.port!=='5433'||u.pathname!=='/ai_hr_board2_upgrade'||u.search||u.hash)throw new Error('Only the named disposable Board 2 upgrade database is allowed.');
}
if(new URL(process.env.DATABASE_URL!).username!=='ai_hr_app'||new URL(process.env.MIGRATION_DATABASE_URL!).username==='ai_hr_app')throw new Error('Separate application and owner roles required.');
const expected=phase==='prepare'?process.env.BOARD2_BASELINE_REF:process.env.BOARD2_CANDIDATE_REF;
if(!expected)throw new Error('Supply the exact reviewed baseline/candidate ref.');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(head!==execFileSync('git',['rev-parse',expected],{encoding:'utf8'}).trim())throw new Error('Checkout does not match the explicit baseline/candidate ref.');
const directory=resolve(process.env.BOARD2_UPGRADE_ARTIFACT_DIR??'scratchpad/board2-approved-ten-20261022/upgrade');
const file=resolve(directory,'populated-before.json');
const TABLES=['tenant','company','person','employment','assignment','reporting_line','app_user','role_assignment','compensation','employee_statutory_my','employee_tp3','tp1_relief','pay_period','payroll_batch','payslip','attendance','attendance_correction','attendance_workflow_template','attendance_workflow_request','domain_event','tenant_module'] as const;
type Ledger={hash:string;created_at:string};
type Snapshot={baseline:string;tenantId:string;companyId:string;batchId:string;correctionId:string;tables:Record<string,{columns:string[];rows:string[]}>;ledger:Ledger[]};
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL=process.env.MIGRATION_DATABASE_URL;

async function main(){
 const {seedBase,owner,closeAll,createAppUser,setModule,entitledCtx}=await import('../test/harness');
 const {hireEmployee,setReportingLine}=await import('../core/org');
 const {setCompensation}=await import('../core/comp');
 const payroll=await import('../packs/payroll/service');
 const attendance=await import('../packs/attendance/service');
 const {requirePackFor}=await import('../localization/registry');
 const {eq}=await import('drizzle-orm');
 const s=await import('../db/schema');
 try{
  async function rows(table:string,tenantId:string,columns:string[]){
   if(!(TABLES as readonly string[]).includes(table)||!columns.length)throw new Error('Unknown snapshot table or empty field set.');
   const where=table==='tenant'?'id':'tenant_id';
   // JSONB text preserves exact numeric values; JS never parses or recomputes recorded money.
   return(await owner.client.unsafe<{row:string}[]>(`select (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any($2::text[]))::text as row from public."${table}" t where ${where}=$1::uuid order by 1`,[tenantId,columns])).map(value=>value.row);
  }
  async function ledger(){return owner.client<Ledger[]>`select hash,created_at::text as created_at from drizzle.__drizzle_migrations m order by m.created_at,m.id`;}
  async function compare(before:Snapshot,migrated:boolean){
   if(!before.tenantId||Object.keys(before.tables).length!==TABLES.length)throw new Error('Incomplete populated snapshot.');
   const differences:string[]=[];
   for(const table of TABLES){const saved=before.tables[table];if(!saved||JSON.stringify(await rows(table,before.tenantId,saved.columns))!==JSON.stringify(saved.rows))differences.push(table);}
   const now=await ledger();
   if(JSON.stringify(now.slice(0,before.ledger.length))!==JSON.stringify(before.ledger))differences.push('applied migration prefix');
   if(migrated){
    const names=['0591_my_tp3_private_drafts','0592_attendance_workflow_v4','0593_my_ea_source_eligibility'];
    const expectedHashes=names.map(name=>createHash('sha256').update(readFileSync(new URL(`../db/migrations/${name}.sql`,import.meta.url))).digest('hex'));
    if(now.length!==before.ledger.length+3||JSON.stringify(now.slice(before.ledger.length).map(row=>row.hash))!==JSON.stringify(expectedHashes))differences.push('three exact Board 2 migrations');
   }else if(now.length!==before.ledger.length)differences.push('baseline migration count');
   const report={status:differences.length?'FAIL':'PASS',mode:migrated?'populated-after-upgrade':'baseline-repeat-read-only',baseline:before.baseline,candidate:head,fixtureTenant:before.tenantId,comparedTables:TABLES.length,comparedRows:Object.values(before.tables).reduce((total,value)=>total+value.rows.length,0),appliedBefore:before.ledger.length,appliedAfter:now.length,differences,releaseGate:false};
   writeFileSync(resolve(directory,migrated?'populated-after.json':'populated-repeat.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
   console.log(JSON.stringify(report));if(differences.length)throw new Error('Populated upgrade witness changed; preserve the database for diagnosis.');
  }
  if(existsSync(file)){
   const before=JSON.parse(readFileSync(file,'utf8')) as Snapshot;
   if(phase==='prepare'&&before.baseline!==head)throw new Error('Existing witness belongs to a different baseline; preserving it.');
   await compare(before,phase==='compare');return;
  }
  if(phase==='compare')throw new Error('A populated baseline must be captured before migration.');
  // seedBase INSERTs a separate synthetic tenant; resetDb/db:seed are deliberately never called.
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);
  if(tenants.some(row=>row.id!==DEMO_TENANT_ID&&row.id!==SYSTEM_TENANT_ID))throw new Error('Unexpected or partially prepared tenant exists without a completed snapshot; preserve and inspect it.');
  const base=await seedBase();for(const code of ['attendance','payroll','typed_pay_components'])await setModule(base.tenantId,code,'active');
  const root=await entitledCtx(base),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
  const worker=await hireEmployee(root,{person:{fullName:'Board 2 fictional upgrade employee',primaryEmail:'board2-upgrade-employee@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
  const superior=await hireEmployee(root,{person:{fullName:'Board 2 fictional upgrade superior',primaryEmail:'board2-upgrade-superior@example.invalid'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const userId=await createAppUser(base.tenantId,worker.personId,'employee');await createAppUser(base.tenantId,superior.personId,'manager');
  const own={...root,userId,personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}]};
  for(const [index,person] of [worker,superior].entries()){
   await setCompensation(root,{employmentId:person.employmentId,basicSalary:5000+index*1000,effectiveFrom:`${year-(index===0?1:2)}-01-01`});
   await requirePackFor('MY').statutory.set(root,{personId:person.personId,icNumber:`90010110${String(index+1).padStart(4,'0')}`,taxCategory:1,numChildren:0});
  }
  await payroll.saveTp3(root,{personId:worker.personId,assessmentYear:year,deductionMonth:null,previousEmployers:[{name:'Fictional previous employer',tin:'F000001'}],sectionC:{c1:{amount:10000},c3:{amount:1000},c5:{amount:500}},sectionD:{},declarationAccepted:true,remarks:'Fictional retained HR note'});
  const tp1=await payroll.submitTp1ForPerson(root,{personId:worker.personId,assessmentYear:year,deductionMonth:null,declarationAccepted:true,categories:{form:'tp1-2026',items:{c5:{subItems:{a:100}}},rebates:{}}});
  await payroll.approveTp1ForPerson(root,{personId:worker.personId,id:tp1.id,approvedMonth:Number(today.slice(5,7)),approvedYear:year});
  await setReportingLine(root,{subordinateEmploymentId:worker.employmentId,managerEmploymentId:superior.employmentId,lineType:'administrative',validFrom:`${year-1}-01-01`});
  await attendance.checkIn(root,{employmentId:worker.employmentId,date:today,time:'08:00',manual:true});await attendance.checkOut(root,{employmentId:worker.employmentId,date:today,time:'17:00',manual:true});
  await attendance.saveAttendanceWorkflow(root,{companyId:base.companyId,applicationType:'irregularity',routingVersion:3,code:'BOARD2_BASELINE_V3',name:'Fictional retained v3 route',priority:100,active:true,criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Level 1',mode:'any_one',source:{kind:'direct_manager',depth:1},hrAlternative:false}]});
  await attendance.setAttendanceWorkflowEnabled(root,base.companyId,'irregularity',true);
  const correction=await attendance.requestAttendanceCorrection(own,{employmentId:worker.employmentId,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional pre-upgrade pending request'});
  const batch=await payroll.createBatch(root,{companyId:base.companyId,payPeriod:today.slice(0,7),paymentDate:today});await payroll.generatePayslips(root,{batchId:batch.batchId});await payroll.closeBatch(root,{batchId:batch.batchId});
  const slips=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batch.batchId));
  if(slips.length!==2||slips.some(row=>Number(row.grossPay)<=0))throw new Error('Baseline needs two real positive generated payslips.');
  const tables:Snapshot['tables']={};
  for(const table of TABLES){const columns=(await owner.client<{column_name:string}[]>`select column_name from information_schema.columns where table_schema='public' and table_name=${table} order by ordinal_position`).map(row=>row.column_name);tables[table]={columns,rows:await rows(table,base.tenantId,columns)};}
  for(const table of ['employee_tp3','tp1_relief','payslip','attendance_workflow_request'])if(!tables[table].rows.length)throw new Error(`Populated witness is vacuous for ${table}.`);
  const snapshot:Snapshot={baseline:head,tenantId:base.tenantId,companyId:base.companyId,batchId:batch.batchId,correctionId:correction.correctionId,tables,ledger:await ledger()};
  mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'PREPARED',baseline:head,tables:TABLES.length,rows:Object.values(tables).reduce((total,value)=>total+value.rows.length,0),snapshot:file,releaseGate:false}));
 }finally{await closeAll();}
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
