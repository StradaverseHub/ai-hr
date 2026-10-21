/** Fictional, named-local-database task journey. No production/shared target is accepted. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/private/tmp/aihr-board1-remaining4-20261021',destination=root+'/home-task-fixture.json';
for(const raw of [process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL]){
 const url=new URL(raw??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5433'
  ||url.pathname!=='/ai_hr_board1_home_acceptance'||url.search||url.hash)throw Error('Named disposable local Home database only.');
}
if(process.env.NODE_ENV==='production')throw Error('Development journey only.');
const command=process.argv[2],expected=Number(process.argv[3]);
if(command!=='prepare'&&(command!=='verify'||![0,1,2].includes(expected)))throw Error('Use prepare or verify with the expected remaining task count.');
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;process.env.TEST_MIGRATION_DATABASE_URL=process.env.MIGRATION_DATABASE_URL;
type Fixture=import('../test/harness').Base&{
 people:Record<'employee'|'manager',{employmentId:string;personId:string;userId:string}>};
type Receipt={tenantId:string;requestIds:string[];dates:string[];managerUserId:string;subjectEmploymentId:string};
async function main(){
 const f=JSON.parse(await readFile(root+'/home-fixture.json','utf8')) as Fixture;
 const prior=await readFile(destination,'utf8').then(value=>JSON.parse(value) as Receipt,()=>null);
 const {and,eq,isNull,inArray}=await import('drizzle-orm'),s=await import('../db/schema');
 const {owner,entitledCtx,closeAll}=await import('../test/harness');
 const {setReportingLine}=await import('../core/org');
 const {setLeaveApprovalPolicy,requestLeave}=await import('../packs/leave/service');
 const {listPendingTasks}=await import('../core/approvals-inbox');
 const {todayInKualaLumpur}=await import('../lib/hr-date');
 const {withTenant}=await import('../db/client');
 try{
  const [tenant]=await owner.db.select().from(s.tenant).where(eq(s.tenant.id,f.tenantId));
  if(tenant?.name!=='Fictional Board 1 Home Acceptance')throw Error('Fictional Home tenant receipt mismatch.');
  for(const subject of [f.people.employee,f.people.manager]){
   const [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.id,subject.userId),eq(s.appUser.tenantId,f.tenantId)));
   const [employment]=await owner.db.select().from(s.employment).where(and(eq(s.employment.id,subject.employmentId),eq(s.employment.tenantId,f.tenantId)));
   if(user?.personId!==subject.personId||employment?.personId!==subject.personId||employment?.companyId!==f.companyId)throw Error('Fictional own-principal receipt mismatch.');
  }
  const admin={...await entitledCtx(f),grants:[{role:'hr_admin' as const,companyId:null}]};
  const manager={...admin,userId:f.people.manager.userId,personId:f.people.manager.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
  const employee={...manager,userId:f.people.employee.userId,personId:f.people.employee.personId};
  let receipt=prior;
  if(command==='prepare'&&!receipt){
   const date=todayInKualaLumpur();
   const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,manager.userId));
   if(grants.length!==1||grants[0].companyId!==null||!['manager','employee'].includes(grants[0].role))throw Error('Refusing an unexpected fictional manager grant.');
   await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.id,grants[0].id));
   const lines=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,f.people.employee.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt))).orderBy(s.reportingLine.id);
   if(lines.length>1||lines.some(row=>row.managerEmploymentId!==f.people.manager.employmentId||row.validFrom>date))throw Error('Refusing to replace an unexpected fictional reporting line.');
   if(!lines.length)await setReportingLine(admin,{subordinateEmploymentId:f.people.employee.employmentId,managerEmploymentId:f.people.manager.employmentId,lineType:'administrative',validFrom:date});
   await setLeaveApprovalPolicy(admin,{companyId:f.companyId,levels:['direct_manager']});
   const hash=createHash('sha256').update('board1-home-task-ledger:'+f.tenantId).digest('hex');
   const ledgerId=[hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
   await owner.db.insert(s.leaveLedger).values({id:ledgerId,tenantId:f.tenantId,employmentId:f.people.employee.employmentId,leaveTypeId:f.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:date.slice(0,4)+'-01-01'}).onConflictDoNothing({target:s.leaveLedger.id});
   const [ledger]=await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.id,ledgerId));
   if(ledger.employmentId!==f.people.employee.employmentId||ledger.leaveTypeId!==f.annualLeaveTypeId||Number(ledger.days)!==20)throw Error('Fictional accrual witness mismatch.');
   const add=(value:string,days:number)=>new Date(Date.parse(value+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
   const dates:string[]=[],requestIds:string[]=[];let next=add(date,3);
   for(let index=0;index<2;index++){
    while([0,6].includes(new Date(next+'T12:00:00Z').getUTCDay()))next=add(next,1);
    const reason='Fictional Board 1 assigned-task acceptance '+(index+1);
    const existing=await owner.db.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,f.tenantId),eq(s.leaveRequest.employmentId,f.people.employee.employmentId),eq(s.leaveRequest.reason,reason))).orderBy(s.leaveRequest.id);
    if(existing.length>1||existing.some(row=>row.startDate!==next||row.endDate!==next||row.leaveTypeId!==f.annualLeaveTypeId))throw Error('Fictional pending-request witness mismatch.');
    const id=existing[0]?.id??(await requestLeave(employee,{employmentId:f.people.employee.employmentId,leaveTypeId:f.annualLeaveTypeId,startDate:next,endDate:next,reason,today:date})).leaveRequestId;
    dates.push(next);requestIds.push(id);next=add(next,1);
   }
   receipt={tenantId:f.tenantId,requestIds,dates,managerUserId:manager.userId,subjectEmploymentId:f.people.employee.employmentId};
   await writeFile(destination,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(!receipt||receipt.tenantId!==f.tenantId||receipt.managerUserId!==manager.userId||receipt.subjectEmploymentId!==f.people.employee.employmentId)throw Error('Task fixture receipt mismatch.');
  const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,manager.userId));
  if(grants.length!==1||grants[0].role!=='employee'||grants[0].companyId!==null)throw Error('Fictional actor must still have only Employee access.');
  const rows=await owner.db.select({id:s.leaveRequest.id,status:s.leaveRequest.status,startDate:s.leaveRequest.startDate}).from(s.leaveRequest).where(and(eq(s.leaveRequest.tenantId,f.tenantId),inArray(s.leaveRequest.id,receipt.requestIds))).orderBy(s.leaveRequest.startDate,s.leaveRequest.id);
  if(rows.length!==2||rows.some(row=>!receipt.dates.includes(row.startDate)))throw Error('Saved task identities changed.');
  const tasks=await listPendingTasks(manager,[f.companyId],{attendance:false,claims:false});
  if(tasks.some(row=>row.kind!=='leave'||!receipt!.requestIds.includes(row.id)))throw Error('Unexpected task outside the fictional witness.');
  if(command==='verify'&&(tasks.length!==expected||rows.filter(row=>row.status==='pending').length!==expected))throw Error('Actual remaining task/state count mismatch.');
  // The real app user context must see the same status as owner readback, not a guessed toast result.
  const ownRows=await withTenant(manager,tx=>tx.select({id:s.leaveRequest.id,status:s.leaveRequest.status}).from(s.leaveRequest).where(inArray(s.leaveRequest.id,receipt!.requestIds)).orderBy(s.leaveRequest.id));
  if(ownRows.length!==2)throw Error('Fictional actor cannot reach its real workflow subjects.');
  if(command==='verify')await writeFile(root+'/home-editor-app/tasks-remaining-'+expected+'.json',JSON.stringify({claim:'Fictional local actual-app task readback only',source:process.env.BOARD1_SOURCE,remaining:expected,rows,ownRows,tasks},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Fictional task identities verified; Employee-only manager has '+tasks.length+' actual assignments.');
 }finally{await closeAll();}
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
