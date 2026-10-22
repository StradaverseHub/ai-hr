import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {MasterReportAccessError} from '../core/employee-master-access';
import {getEmployeeMasterReport,getExecutableEmployeeMasterReport,listEmployeeMasterReports,runEmployeeMasterReport,saveEmployeeMasterReport} from '../core/employee-master-reports';
import {employeeMasterRecipientOptions,getEmployeeMasterSchedule,saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
import {defaultMasterColumn,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base,ctx:SessionContext,employee:Awaited<ReturnType<typeof hireEmployee>>,receiverId:string;
const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
const name=PERSONNEL_FIELDS.find(field=>field.owner==='person'&&field.ownerField==='fullName')!;
const salary=PERSONNEL_FIELDS.find(field=>field.owner==='compensation'&&field.ownerField==='basicSalary')!;
const spec=():EmployeeMasterSpec=>({v:2,asAt:todayInKualaLumpur(),companyIds:[base.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}});
const save=(value=spec(),title='Fictional definition')=>saveEmployeeMasterReport(ctx,[base.companyId],{name:title,description:'Definition recovery fixture',sharedRoleIds:[],spec:value});

beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();ctx={...adminCtx(base),personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const hired=new Date(todayInKualaLumpur()+'T00:00:00Z');hired.setUTCDate(hired.getUTCDate()-90);
 employee=await hireEmployee(ctx,{person:{fullName:'Synthetic definition employee',primaryEmail:'definition-'+randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:hired.toISOString().slice(0,10)});
 const [receiver]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,personId:employee.personId,workosUserId:'definition-receiver-'+randomUUID()}).returning({id:schema.appUser.id});receiverId=receiver.id;
});

describe('Saved Employee Master definition recovery',()=>{
 it('keeps an expired current-only condition visible for repair while refusing execution and enabling, and permits disabling its retained schedule',async()=>{
  expect(name.history).toBe('current');
  const definition=spec();definition.expression={id:'root',type:'group',logic:'and',children:[{id:'name',type:'condition',field:name.id,operator:'contains',value:'Synthetic'}]};
  const saved=await save(definition,'Fictional dated condition'),healthy=await save(spec(),'Fictional healthy listing control');
  expect((await runEmployeeMasterReport(ctx,[base.companyId],{id:saved.id})).result.employeeCount).toBe(1);
  // A retained schedule is an explicit test fixture, not evidence of provider consent or actual delivery.
  await withTenant(ctx,tx=>tx.insert(schema.customReportSchedule).values({tenantId:base.tenantId,reportId:saved.id,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:receiverId,employmentId:employee.employmentId}],reportVersion:saved.version,reviewedDigest:'d'.repeat(64),nextRunAt:new Date(Date.now()+86_400_000)}));
  const tomorrow=new Date(definition.asAt+'T12:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  // Only the report application's calendar advances. PostgreSQL/Auth clocks are not being simulated.
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(tomorrow);
  expect((await getEmployeeMasterReport(ctx,[base.companyId],saved.id)).spec).toEqual(definition);
  expect((await listEmployeeMasterReports(ctx,[base.companyId],{all:true})).map(row=>row.id).sort()).toEqual([saved.id,healthy.id].sort());
  await expect(getExecutableEmployeeMasterReport(ctx,[base.companyId],saved.id)).rejects.toThrow('current-only');
  const recipientPolicy=vi.fn(async()=>[]);
  await expect(employeeMasterRecipientOptions(ctx,[base.companyId],saved.id,recipientPolicy)).rejects.toThrow('current-only');
  expect(recipientPolicy).not.toHaveBeenCalled();
  await expect(runEmployeeMasterReport(ctx,[base.companyId],{id:saved.id})).rejects.toThrow('current-only');
  await expect(save(definition,'Cannot silently resave stale execution')).rejects.toThrow('current-only');
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');
  await expect(saveEmployeeMasterSchedule(ctx,[base.companyId],{reportId:saved.id,version:saved.version,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:receiverId,employmentId:employee.employmentId}]})).rejects.toThrow('current-only');
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','false');
  await saveEmployeeMasterSchedule(ctx,[base.companyId],{reportId:saved.id,version:saved.version,enabled:false,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[]});
  expect(await getEmployeeMasterSchedule(ctx,saved.id)).toMatchObject({enabled:false,nextRunAt:null});
  expect((await getEmployeeMasterReport(ctx,[base.companyId],saved.id)).spec.asAt).toBe(definition.asAt);
  const repaired={...definition,asAt:todayInKualaLumpur()};
  await saveEmployeeMasterReport(ctx,[base.companyId],{id:saved.id,version:saved.version,name:'Explicitly repaired definition',description:'Actual owner chooses the new date',sharedRoleIds:[],spec:repaired});
  expect((await getEmployeeMasterReport(ctx,[base.companyId],saved.id)).spec).toEqual(repaired);
  expect((await runEmployeeMasterReport(ctx,[base.companyId],{id:saved.id})).result.employeeCount).toBe(1);
  expect(await getEmployeeMasterSchedule(ctx,saved.id)).toMatchObject({enabled:false,nextRunAt:null});
 });

 it('hides a definition after its field permission is revoked without breaking unrelated reports or crossing tenants',async()=>{
  const definition={...spec(),columns:[defaultMasterColumn(salary)]};
  const restricted=await save(definition,'Fictional compensation definition'),healthy=await save(spec(),'Fictional authorised definition');
  expect((await getEmployeeMasterReport(ctx,[base.companyId],restricted.id)).spec.columns[0].field).toBe(salary.id);
  await setPayrollPermissionGrant(ctx,{companyId:base.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
  await expect(getEmployeeMasterReport(ctx,[base.companyId],restricted.id)).rejects.toBeInstanceOf(MasterReportAccessError);
  expect((await listEmployeeMasterReports(ctx,[base.companyId],{all:true})).map(row=>row.id)).toEqual([healthy.id]);
  await expect(runEmployeeMasterReport(ctx,[base.companyId],{id:restricted.id})).rejects.toThrow(/unavailable|permitted/i);
  const other=await seedBase(),foreign={...adminCtx(other),personId:null,grants:[{role:'hr_admin',companyId:null}]};
  await expect(getEmployeeMasterReport(foreign,[other.companyId],healthy.id)).rejects.toBeInstanceOf(MasterReportAccessError);
  expect(await listEmployeeMasterReports(foreign,[other.companyId],{all:true})).toEqual([]);
 });
});
