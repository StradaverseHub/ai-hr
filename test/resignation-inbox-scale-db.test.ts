/** SCALE-AND-RELEASE-RULES 2–3: independent, pre-seed manifest; 70 populated companies,
 * 1,120 employments, bounded SQL pages, private FYI projections and unchanged legacy populations.
 * Owner bulk rows are synthetic fixtures, never an application write path. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {prepareResignationProofTx} from '../core/resignation-proof';
import {beforeAll,beforeEach,afterAll,afterEach,vi,it,expect} from 'vitest';
import type {SessionContext} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll,createAppUser,setModule} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {observeNativeRead,type NativeReadQuery} from './helpers/native-read-observer';
import {commandResignationJourney,resignationInbox,resignationCase} from '../packs/lifecycle/resignation/service';
import {listResignationRequests} from '../core/offboarding';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
type Task={id:string;caseId:string;number:number;companyId:string;actor:string;kind:'decision'|'fyi'|'upload'|'review';dueOn:string|null;team:boolean;tagged:boolean;onIt:{id:string;name:string}|null};
type PersonRow={n:number;personId:string;employmentId:string;companyId:string;requestId:string;name:string;code:string;createdAt:string;managed:boolean;legacy:boolean};
const compare=(a:Task,b:Task)=>a.dueOn===b.dueOn?b.number-a.number||a.id.localeCompare(b.id):a.dueOn===null?1:b.dueOn===null?-1:a.dueOn.localeCompare(b.dueOn);

it('keeps all-company and single-company resignation inboxes bounded and equivalent to the seed manifest across roles',async()=>{
 const f=await resignationJourneyFixture();
 const [canonical]=await owner.db.execute<{data:Record<string,unknown>}>(sql`select data from resignation_journey where tenant_id=${f.base.tenantId}::uuid and id=${f.journey.id}::uuid`);
 await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});
 const companies=Array.from({length:71},(_,i)=>({id:randomUUID(),name:`Fictional resignation scale company ${String(i).padStart(3,'0')}`}));
 const managerId=await createAppUser(f.base.tenantId,null,'manager'),scopedHrId=await createAppUser(f.base.tenantId,null,'hr_admin'),strangerId=await createAppUser(f.base.tenantId,null,'hr_admin');
 const ctx=(userId:string,roles:string[]):SessionContext=>({...f.admin,userId,personId:null,roles,grants:undefined});
 const manager=ctx(managerId,['manager']),scopedHr={...ctx(scopedHrId,['hr_admin']),grants:[{role:'hr_admin',companyId:companies[0].id}]},stranger=ctx(strangerId,['hr_admin']);
 const today=todayInKualaLumpur(),tasks:Task[]=[],people:PersonRow[]=[];
 for(let n=0;n<1120;n++){
  const companyIndex=Math.floor(n/16),slot=n%16,personId=randomUUID(),employmentId=randomUUID(),requestId=randomUUID(),companyId=companies[companyIndex].id;
  const person={n,personId,employmentId,companyId,requestId,name:`Fictional scale employee ${String(n).padStart(4,'0')}`,code:`RS-SCALE-${String(n).padStart(4,'0')}`,createdAt:new Date(Date.UTC(2025,0,1,0,0,n)).toISOString(),managed:slot<8,legacy:slot>=8&&slot<12};people.push(person);
  if(!person.managed)continue;
  const dueOn=n%4===3?null:addDaysIso(today,[-2,0,2][n%4]),number=100000+n;
  const add=(actor:string,kind:Task['kind'],team=false,tagged=false,onIt:Task['onIt']=null)=>tasks.push({id:`${requestId}:${kind}`,caseId:requestId,number,companyId,actor,kind,dueOn,team,tagged,onIt});
  add(f.managerUserId,'decision');add(f.fyiUserId,'fyi');add(managerId,'upload',n%2===0,n%3===0,n%5===0?{id:managerId,name:'Assigned scale manager'}:null);
  if(companyIndex===0)add(scopedHrId,'review');
 }
 // This manifest is complete before any synthetic case is inserted; assertions never infer expectations from reads.
 const legacy=people.filter(p=>p.legacy).sort((a,b)=>b.n-a.n),managed=people.filter(p=>p.managed);
 expect({companies:companies.length,populated:70,employments:people.length,managed:managed.length,legacy:legacy.length,noRequest:people.filter(p=>!p.managed&&!p.legacy).length}).toEqual({companies:71,populated:70,employments:1120,managed:560,legacy:280,noRequest:280});
 await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) select x.id,${f.base.tenantId}::uuid,x.name from jsonb_to_recordset(${JSON.stringify(companies)}::jsonb) as x(id uuid,name text)`);
 await owner.db.execute(sql`update role_assignment set company_id=${companies[0].id}::uuid where tenant_id=${f.base.tenantId}::uuid and app_user_id=${scopedHrId}::uuid`);
 const flat=people.map(p=>({...p,tenantId:f.base.tenantId}));
 await owner.db.execute(sql`insert into person(id,tenant_id,full_name,primary_email) select x."personId",${f.base.tenantId}::uuid,x.name,x."personId"::text||'@resignation-scale.example.test' from jsonb_to_recordset(${JSON.stringify(flat)}::jsonb) as x("personId" uuid,name text)`);
 await owner.db.execute(sql`insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code) select x."employmentId",${f.base.tenantId}::uuid,x."personId",x."companyId",'2024-01-01',x.code from jsonb_to_recordset(${JSON.stringify(flat)}::jsonb) as x("employmentId" uuid,"personId" uuid,"companyId" uuid,code text)`);
 // Historical legacy requests and managed snapshots predate reactivation; unsigned active-company inserts are forbidden.
 await setModule(f.base.tenantId,'lifecycle','disabled');
 await owner.db.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,reason,status,created_at) select x."requestId",${f.base.tenantId}::uuid,x."employmentId",x."personId",'2027-03-01','Fictional scale resignation','pending',x."createdAt" from jsonb_to_recordset(${JSON.stringify(flat.filter(p=>p.managed||p.legacy))}::jsonb) as x("requestId" uuid,"employmentId" uuid,"personId" uuid,"createdAt" timestamptz)`);
 await owner.db.execute(sql`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) select ${f.base.tenantId}::uuid,x."employmentId",24680.12,'SGD','2024-01-01' from jsonb_to_recordset(${JSON.stringify(managed)}::jsonb) as x("employmentId" uuid)`);
 const legacyFiles=[legacy[0],legacy.find(p=>p.companyId===companies[0].id)!].map(p=>({id:randomUUID(),requestId:p.requestId,employmentId:p.employmentId,fileName:`legacy-${p.code}.pdf`,mimeType:'application/pdf'}));
 await owner.db.execute(sql`insert into resignation_request_attachment(id,tenant_id,resignation_request_id,employment_id,content,file_name,mime_type,size_bytes) select x.id,${f.base.tenantId}::uuid,x."requestId",x."employmentId",convert_to('LEGACY PRIVATE FILE BYTES','UTF8'),x."fileName",x."mimeType",25 from jsonb_to_recordset(${JSON.stringify(legacyFiles)}::jsonb) as x(id uuid,"requestId" uuid,"employmentId" uuid,"fileName" text,"mimeType" text)`);
 const rows=managed.map(p=>{
  const ownTasks=tasks.filter(t=>t.caseId===p.requestId),number=100000+p.n,decision=ownTasks.find(t=>t.kind==='decision')!;
  const facts={...(canonical.data.facts as object),employmentId:p.employmentId,personId:p.personId,companyId:p.companyId,employeeName:p.name,employeeCode:p.code,companyName:companies[Math.floor(p.n/16)].name,basicSalary:'24680.12',currency:'SGD',employeeUserId:null,supervisorUserId:null,businessGroupId:null,businessGroup:'',departmentId:null,department:'',positionId:null,position:'',jobGradeId:null,jobGrade:'',employmentType:'permanent',confirmed:true,finalConfirmationDate:null,noticeBefore:null,noticeAfter:null};
  const data={...structuredClone(canonical.data),facts,lastWorkingDay:'2027-03-01',reason:'Fictional scale resignation',decision:{id:decision.id,runId:randomUUID(),to:[f.managerUserId],watch:[f.fyiUserId],choices:'both',canComment:true,dueOn:decision.dueOn},offer:{position:'PRIVATE OFFER POSITION',jobGrade:'PRIVATE OFFER GRADE',basicSalary:'98765.43',effectiveDate:'2027-03-01',justification:'PRIVATE OFFER JUSTIFICATION'},letters:[],releasedDocuments:[],waits:[],tasks:ownTasks.map(t=>({id:t.id,caseId:p.requestId,caseNumber:`RSN-${number}`,revision:1,employeeName:p.name,employeeCode:p.code,title:`${t.kind} for ${p.name}`,kind:t.kind,documentId:null,dueOn:t.dueOn,overdue:false,team:t.team,tagged:t.tagged,status:'todo',onIt:t.onIt,canComment:t.kind==='fyi',actionable:t.kind!=='fyi',uploadLabel:t.kind==='upload'?'Supporting evidence':null,userIds:[t.actor]}))};
  return{...p,number,data,participants:[...new Set(ownTasks.map(t=>t.actor))]};
 });
 // Four chunks keep fixture transport bounded while avoiding 1,120 service-hire loops.
 for(let offset=0;offset<rows.length;offset+=140)await owner.db.execute(sql`insert into resignation_journey(tenant_id,id,employment_id,company_id,person_id,number,stage,data,participant_ids,submitted_on) overriding system value select ${f.base.tenantId}::uuid,x."requestId",x."employmentId",x."companyId",x."personId",x.number,'decision',x.data,x.participants,'2026-11-01' from jsonb_to_recordset(${JSON.stringify(rows.slice(offset,offset+140))}::jsonb) as x("requestId" uuid,"employmentId" uuid,"companyId" uuid,"personId" uuid,number bigint,data jsonb,participants uuid[])`);
 await setModule(f.base.tenantId,'lifecycle','active');
 const evidence:{role:string;scope:string;offset:number;statements:number;rows:number;ms:number}[]=[];
 const planSources=new Map<string,NativeReadQuery[]>();
 const actors=[{name:'group HR',ctx:f.admin,kind:'approvals' as const,id:f.managerUserId},{name:'non-HR manager',ctx:manager,kind:'tasks' as const,id:managerId},{name:'FYI employee',ctx:f.watcher,kind:'approvals' as const,id:f.fyiUserId},{name:'company HR',ctx:scopedHr,kind:'approvals' as const,id:scopedHrId},{name:'own employee',ctx:f.staff,kind:'tasks' as const,id:f.employeeUserId},{name:'unassigned HR',ctx:stranger,kind:'approvals' as const,id:strangerId}];
 async function page(actor:typeof actors[number],companyIds:string[]|undefined,offset=0,filter:'all'|'assigned'|'tagged'|'team'|'overdue'='all'){
  const base=tasks.filter(t=>t.actor===actor.id&&(!companyIds||companyIds.includes(t.companyId))).sort(compare);
  const counts={all:base.length,assigned:base.filter(t=>!t.team||t.onIt?.id===actor.id).length,tagged:base.filter(t=>t.tagged).length,team:base.filter(t=>t.team).length,overdue:base.filter(t=>t.dueOn!==null&&t.dueOn<today).length};
  const selected=base.filter(t=>filter==='all'||filter==='assigned'&&(!t.team||t.onIt?.id===actor.id)||filter==='tagged'&&t.tagged||filter==='team'&&t.team||filter==='overdue'&&t.dueOn!==null&&t.dueOn<today),expected=selected.slice(offset,offset+50);
  const probe=observeNativeRead(),started=performance.now();let result:Awaited<ReturnType<typeof resignationInbox>>;
  try{result=await resignationInbox(actor.ctx,{kind:actor.kind,companyIds,limit:50,offset,filter});}finally{probe.restore();}
  expect(result!.items.map(t=>t.id),`${actor.name}/${companyIds?'one company':'all'}/${filter}/${offset}`).toEqual(expected.map(t=>t.id));
  expect(result!.total).toBe(selected.length);expect(result!.actionableTotal).toBe(base.filter(t=>t.kind!=='fyi').length);expect(result!.fyiTotal).toBe(base.filter(t=>t.kind==='fyi').length);expect(result!.counts).toEqual(counts);
  expect(result!.cases.map(c=>c.id)).toEqual([...new Set(expected.map(t=>t.caseId))]);
  if(actor.id===f.managerUserId&&offset===0&&filter==='all'&&(!companyIds||companyIds[0]===companies[0].id)){
   const statements=probe.queries.filter(q=>/from resignation_journey j cross join lateral/i.test(q.sql));
   expect(statements).toHaveLength(2);planSources.set(companyIds?'one':'all',statements);
  }
  expect(probe.queries.length).toBeLessThanOrEqual(4);expect(probe.queries.some(q=>q.sql.includes('resignation_journey_context'))).toBe(false);expect(probe.queries.every(q=>(q.rows??0)<=50)).toBe(true);
  if(actor.id===f.managerUserId)for(const c of result!.cases){expect(c.offer?.basicSalary).toBe('98765.43');expect(c.currentBasicSalary).toBe('24680.12');expect(c.currency).toBe('SGD');}
  if(actor.id!==f.managerUserId)for(const c of result!.cases){expect(c.offer).toBeNull();expect(c.currentBasicSalary).toBeNull();expect(c.currency).toBeNull();expect(JSON.stringify(c)).not.toMatch(/98765\.43|24680\.12|PRIVATE OFFER/);}
  evidence.push({role:actor.name,scope:companyIds?companyIds[0]:'all',offset,statements:probe.queries.length,rows:result!.items.length,ms:Math.round(performance.now()-started)});return result!;
 }
 for(const actor of actors){await page(actor,undefined);await page(actor,[companies[0].id]);await page(actor,[companies[70].id]);}
 for(const actor of actors.slice(0,3))for(const offset of [50,500,550,600])await page(actor,undefined,offset);
 for(const filter of ['assigned','tagged','team','overdue'] as const){await page(actors[1],undefined,0,filter);await page(actors[1],[companies[0].id],0,filter);}
 // The previous request reader retains its legacy rows, order and metadata; managed rows never enter it.
 for(const [actor,expected] of [[f.admin,legacy.slice(0,100)],[scopedHr,legacy.filter(p=>p.companyId===companies[0].id)],[manager,[]],[f.watcher,[]],[f.staff,[]],[stranger,legacy.slice(0,100)]] as const){
  const actual=await listResignationRequests(actor,{status:'pending'});expect(JSON.stringify(actual)).not.toContain('LEGACY PRIVATE FILE BYTES');expect(actual.map(r=>r.id)).toEqual(expected.map(p=>p.requestId));
  expect(actual.map(r=>({id:r.id,name:r.employee,code:r.employeeCode,status:r.status,documents:r.documents}))).toEqual(expected.map(p=>({id:p.requestId,name:p.name,code:p.code,status:'pending',documents:legacyFiles.filter(file=>file.requestId===p.requestId).map(file=>({id:file.id,fileName:file.fileName,mimeType:file.mimeType}))})));
 }
 // Rebind captured placeholders only: these are the reader's actual SQL/parameters, not a second implementation.
 const explainActual=(query:NativeReadQuery):SQL=>{
  const fragments:SQL[]=[],pattern=/\$(\d+)/g;let from=0;for(const match of query.sql.matchAll(pattern)){
   fragments.push(sql.raw(query.sql.slice(from,match.index)),sql`${query.params[Number(match[1])-1]}`);from=match.index!+match[0].length;
  }
  fragments.push(sql.raw(query.sql.slice(from)));return sql`explain (analyze,buffers,format json) ${sql.join(fragments,sql.raw(''))}`;
 };
 type PlanNode=Record<string,unknown>&{Plans?:PlanNode[];'Node Type':string;'Actual Rows':number;'Actual Loops':number};
 type ActualPlan={Plan:PlanNode;'Planning Time':number;'Execution Time':number;JIT?:unknown};
 const planEvidence=await withTenant(f.admin,async tx=>{
  const [profile]=await tx.execute<{role:string;backend:number;bypass:boolean;rowSecurity:string;jit:string;workMem:string;sharedBuffers:string;maxParallelWorkersPerGather:string;serverVersion:string}>(sql`select current_user as role,pg_backend_pid() as backend,(select rolbypassrls from pg_roles where rolname=current_user) as bypass,current_setting('row_security') as "rowSecurity",current_setting('jit') as jit,current_setting('work_mem') as "workMem",current_setting('shared_buffers') as "sharedBuffers",current_setting('max_parallel_workers_per_gather') as "maxParallelWorkersPerGather",current_setting('server_version') as "serverVersion"`);
  expect(profile.role).toBe('ai_hr_app');expect(profile.bypass).toBe(false);expect(profile.rowSecurity).toBe('on');expect(profile.jit).toBe('off');
  const plans=[];
  for(const scope of ['all','one'] as const){
   await prepareResignationProofTx(tx,f.admin,{operation:'read',args:{mode:'inbox',companyIds:scope==='all'?[]:[companies[0].id]}});
   const sources=planSources.get(scope);expect(sources).toHaveLength(2);
   for(const [index,source] of sources!.entries()){
    const [result]=await tx.execute<{'QUERY PLAN':ActualPlan[]}>(explainActual(source)),actual=result['QUERY PLAN'][0];
    // Nonempty page cardinality independently proves that these are authorized RLS plans under the signed scope.
    expect(actual.Plan['Actual Rows']).toBe(index===0?1:scope==='all'?50:8);
    const nodes:Record<string,unknown>[]=[];const collect=(node:PlanNode)=>{nodes.push({type:node['Node Type'],relation:node['Relation Name']??null,rows:node['Actual Rows'],loops:node['Actual Loops'],sharedHit:node['Shared Hit Blocks']??0,sharedRead:node['Shared Read Blocks']??0,sharedWritten:node['Shared Written Blocks']??0,localHit:node['Local Hit Blocks']??0,tempRead:node['Temp Read Blocks']??0,tempWritten:node['Temp Written Blocks']??0,sortMethod:node['Sort Method']??null,sortSpaceType:node['Sort Space Type']??null,sortSpaceUsed:node['Sort Space Used']??null,hashBatches:node['Hash Batches']??null,peakMemory:node['Peak Memory Usage']??null,diskUsage:node['Disk Usage']??null});for(const child of node.Plans??[])collect(child);};collect(actual.Plan);
    plans.push({scope,query:index===0?'count':'page',planningMs:actual['Planning Time'],executionMs:actual['Execution Time'],jit:actual.JIT??null,nodes,actualPlan:actual});
   }
  }
  return{profile,hostedProfile:process.env.AIHR_CI_PG_PROFILE??null,plans};
 });
 const other=await resignationJourneyFixture();await page(actors[0],[other.base.companyId]);await expect(resignationCase(other.admin,managed[0].requestId)).rejects.toMatchObject({code:'not_found'});
 const outsider=await resignationInbox(other.staff,{kind:'approvals',companyIds:[companies[0].id],limit:50});expect(outsider.total).toBe(0);expect(outsider.items).toEqual([]);expect(outsider.cases).toEqual([]);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'resignation-inbox-scale.json'),JSON.stringify({kind:'RESIGNATION_INBOX_SCALE_V1',companies:71,employments:1120,managed:560,legacy:280,reads:evidence,planEvidence},null,2));
 // 300s headroom for the representative native fixture and complete role/scope/page matrix on hosted PostgreSQL.
},300000);
