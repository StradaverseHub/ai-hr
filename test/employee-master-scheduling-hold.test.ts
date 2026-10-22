import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import type {MasterRecipient} from '../core/employee-master-recipient-types';
const m=vi.hoisted(()=>({report:vi.fn(),write:vi.fn(),event:vi.fn(),scope:vi.fn(),job:vi.fn(),ipc:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,fn:(tx:unknown)=>unknown)=>fn({insert:()=>({values:(value:unknown)=>{m.write(value);return {onConflictDoUpdate:()=>({returning:async()=>[{id:'saved-schedule'}]})};}})})}));
vi.mock('../db/events',()=>({appendEvent:m.event,actorOf:()=>({kind:'user'})}));
vi.mock('../core/employee-master-reports',()=>({getEmployeeMasterReport:m.report,getExecutableEmployeeMasterReport:m.report,runEmployeeMasterReport:vi.fn(),authorizeEmployeeMasterRun:vi.fn()}));
vi.mock('../core/employee-master-access',()=>({MasterReportAccessError:class extends Error{}}));
vi.mock('../core/notification-email',()=>({resolveEmployeeMasterRecipients:vi.fn()}));
vi.mock('../lib/employee-master-export',()=>({serializeEmployeeMaster:vi.fn()}));
vi.mock('../lib/employee-master-field-labels',()=>({employeeMasterFieldLabels:vi.fn()}));
vi.mock('../core/sweep-scope',()=>({loadSweepScope:m.scope}));
vi.mock('../core/job-run',()=>({recordJobRun:m.job}));
vi.mock('../lib/employee-master-delivery-ipc',()=>({employeeMasterDeliveryIpc:m.ipc}));
import {saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
import {sweepEmployeeMasterReports} from '../core/employee-master-delivery';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ctx={tenantId:id(1),userId:id(2),personId:id(3),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
const config={frequency:'weekly' as const,day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},pair={userId:id(4),employmentId:id(5)};
const input={reportId:id(6),version:1,enabled:true,config,recipients:[pair]};
const policy=vi.fn(async()=>[{...pair,context:ctx,scopeIds:[id(7)],label:'Fictional recipient'}] as unknown as MasterRecipient[]);
beforeEach(()=>{vi.clearAllMocks();m.report.mockResolvedValue({id:input.reportId,canEdit:true,version:1,spec:{companyIds:[id(7)]},sharedRoleIds:['hr_admin'],shared:true});m.scope.mockResolvedValue({run:[],skipped:[]});});
afterEach(()=>vi.unstubAllEnvs());
describe('default-off scheduled Employee Master release capability',()=>{
 it.each([undefined,'false','TRUE','1',' true','true '])('refuses enabled persistence for value %s without any owner write',async value=>{
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',value);
  await expect(saveEmployeeMasterSchedule(ctx,[id(7)],input,policy)).rejects.toThrow(/unavailable/i);
  expect(m.write).not.toHaveBeenCalled();expect(m.event).not.toHaveBeenCalled();
 });
 it('retains explicit opt-in and preserves ordinary authorization/recipient validation',async()=>{vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');await expect(saveEmployeeMasterSchedule(ctx,[id(7)],input,policy)).resolves.toEqual({id:'saved-schedule'});expect(m.write).toHaveBeenCalledWith(expect.objectContaining({enabled:true,nextRunAt:expect.any(Date)}));});
 it('can still disable an existing schedule while held, clearing its next date',async()=>{vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',undefined);await expect(saveEmployeeMasterSchedule(ctx,[id(7)],{...input,enabled:false},policy)).resolves.toEqual({id:'saved-schedule'});expect(m.write).toHaveBeenCalledWith(expect.objectContaining({enabled:false,nextRunAt:null}));expect(policy).not.toHaveBeenCalled();expect(m.event).toHaveBeenCalledTimes(1);});
 it.each([undefined,'false'])('does no transport, scope, queue, claim or job logging while held (%s), even with a ready daemon',async value=>{
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',value);const transport=vi.fn(async()=>({version:1,ready:true})),execute=vi.fn(async()=>[]),select=vi.fn();
  expect(await sweepEmployeeMasterReports({execute,select} as never,{transport:transport as never})).toMatchObject({queued:0,attempted:0,unavailable:true});
  for(const fn of [transport,execute,select,m.scope,m.job,m.ipc])expect(fn).not.toHaveBeenCalled();
 });
 it('observes the capability again at each admission rather than caching an earlier opt-in',async()=>{vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');await saveEmployeeMasterSchedule(ctx,[id(7)],input,policy);m.write.mockClear();vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','false');await expect(saveEmployeeMasterSchedule(ctx,[id(7)],input,policy)).rejects.toThrow(/unavailable/i);expect(m.write).not.toHaveBeenCalled();});
});
