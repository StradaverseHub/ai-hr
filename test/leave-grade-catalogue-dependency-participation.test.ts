/** Authored UNRUN: real employee intervals and canonical grade catalogue/import owners. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as tenantDb from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createJobGrade,updateJobGrade,deleteJobGrade,archiveJobGrade} from '../core/admin';
import {applySystemLabelImport,previewSystemLabelImport} from '../core/system-label-import';
import {buildSystemLabelWorkbook} from '../lib/system-label-workbook';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
async function subject(){const grade=await createJobGrade(group(),{code:'PARTICIPATING',name:'Fictional Participating Grade',rank:3});return hireEmployee(group(),{person:{fullName:'Fictional Grade Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,gradeId:grade.id,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function state(){const result:Record<string,unknown>={};for(const table of ['job_grade','grade_group','grade_group_member','employment','assignment','entitlement_eligibility_rule','leave_ledger','profile_option','domain_event']){const [row]=await owner.client.unsafe<{rows:unknown}[]>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t where tenant_id=$1`,[b.tenantId]);result[table]=row.rows;}return result;}
async function held(id:string){let ready!:()=>void,failed!:(e:unknown)=>void,release!:()=>void;const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{failed(Error('owned grade interval timed out'));release();},10000);const pending=withTenant(group(),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await done;});void pending.catch(failed);await started;return{async close(){release();clearTimeout(timer);await pending;}};}
const workbook=()=>buildSystemLabelWorkbook({kinds:['grades'],rows:{grades:[{Code:'IMPORTED_GRADE',Label:'Fictional Imported Grade',Rank:'4',Description:'Fictional description',Status:'Active'}]},references:{companies:[],grades:[],employees:[]}});
describe('grade catalogue source ownership',()=>{
 it.each(['create','update','delete','archive','restore','create-tx','update-tx'] as const)('%s refuses without catalogue/eligibility/employee/ledger/event effects, then applies after release',async kind=>{
  const a=await subject(),target=await createJobGrade(group(),{code:'UNUSED_TARGET',name:'Fictional Unused Target',active:kind!=='restore'}),ctx=group();
  const create={code:'NEW_GRADE',name:'Fictional New Grade',rank:4},update={id:target.id,name:'Fictional Changed Grade',rank:5,code:'RENAMED_TARGET',reason:'Fictional grade correction'};
  const invoke=()=>kind==='create'?createJobGrade(ctx,create):kind==='create-tx'?withTenant(ctx,tx=>createJobGrade(ctx,create,tx)):kind==='update-tx'?withTenant(ctx,tx=>updateJobGrade(ctx,update,tx)):kind==='update'?updateJobGrade(ctx,update):kind==='delete'?deleteJobGrade(ctx,{id:target.id}):archiveJobGrade(ctx,{id:target.id,archived:kind==='archive'});
  const before=await state(),holder=await held(a.employmentId);try{await expect(invoke()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  await invoke();const after=await state(),grades=await owner.db.select().from(schema.jobGrade).where(eq(schema.jobGrade.tenantId,b.tenantId));if(kind.startsWith('create'))expect(grades.some(row=>row.code==='NEW_GRADE')).toBe(true);else if(kind.startsWith('update'))expect(grades.find(row=>row.id===target.id)).toMatchObject({name:'Fictional Changed Grade',rank:5,code:'RENAMED_TARGET'});else if(kind==='delete')expect(grades.some(row=>row.id===target.id)).toBe(false);else if(kind==='archive')expect(grades.find(row=>row.id===target.id)?.archivedAt).toBeInstanceOf(Date);else expect(grades.find(row=>row.id===target.id)?.archivedAt).toBeNull();
  const old=new Set((before.domain_event as {id:string}[]).map(row=>row.id)),added=(after.domain_event as {id:string;event_type:string}[]).filter(row=>!old.has(row.id));expect(added).toHaveLength(1);expect(added[0].event_type).toBe(kind.startsWith('create')?'job-grade.created':kind.startsWith('update')?'job-grade.updated':kind==='delete'?'job-grade.deleted':kind==='archive'?'job-grade.archived':'job-grade.unarchived');
 });
 it('owns the earlier workbook transaction before table/Criteria/source locks, retains current-token checks and creates once after release',async()=>{
  const a=await subject(),bytes=await workbook(),preview=await previewSystemLabelImport(group(),bytes);expect(preview.valid).toBe(true);const before=await state(),holder=await held(a.employmentId);try{await expect(applySystemLabelImport(group(),{bytes,token:preview.token})).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}finally{await holder.close();}
  expect(await applySystemLabelImport(group(),{bytes,token:preview.token})).toMatchObject({imported:1,updated:0,failed:0});const after=await state();await expect(applySystemLabelImport(group(),{bytes,token:preview.token})).rejects.toThrow();expect(await state()).toEqual(after);
 });
 it('captures grade source input and actual caller before asynchronous transaction admission',async()=>{
  const ctx=group(),p={code:'CAPTURED_GRADE',name:'Fictional Captured Grade',rank:7,active:true};let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant,boundary=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});const pending=createJobGrade(ctx,p);
  try{await ready;p.code='RETARGETED';p.name='retargeted';p.active=false;ctx.userId=randomUUID();ctx.grants![0].role='employee';release();await pending;}finally{release();await pending.catch(()=>{});boundary.mockRestore();}const [grade]=await owner.db.select().from(schema.jobGrade).where(eq(schema.jobGrade.code,'CAPTURED_GRADE'));expect(grade).toMatchObject({name:'Fictional Captured Grade',archivedAt:null});
 });
 it('captures workbook bytes/selection/context before asynchronous admission, without mutable-buffer retargeting',async()=>{
  await subject();const bytes=await workbook(),preview=await previewSystemLabelImport(group(),bytes),ctx=group(),p={bytes,token:preview.token,selectedKeys:preview.rows.filter(row=>row.selected).map(row=>row.sheet+':'+row.row)};let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(yes=>{entered=yes;}),pause=new Promise<void>(yes=>{release=yes;});const actual=tenantDb.withTenant;
  // The selected-key set is part of the preview token, so prepare the matching exact selection first.
  const selectedPreview=await previewSystemLabelImport(ctx,bytes,'add',p.selectedKeys);p.token=selectedPreview.token;const block=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(async(c,fn)=>{entered();await pause;return actual(c,fn);});const pending=applySystemLabelImport(ctx,p);
  try{await ready;bytes.fill(0);p.selectedKeys.splice(0);p.token='retargeted';ctx.userId=randomUUID();ctx.grants![0].role='employee';release();expect(await pending).toMatchObject({imported:1});}finally{release();await pending.catch(()=>{});block.mockRestore();}expect(await owner.db.select().from(schema.jobGrade).where(eq(schema.jobGrade.code,'IMPORTED_GRADE'))).toHaveLength(1);
 });
});
