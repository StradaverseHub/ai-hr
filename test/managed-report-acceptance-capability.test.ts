/** Portable cross-owner regression: no root, VM, database or mail; no new projection API. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import type {MasterRecipient} from '../core/employee-master-recipient-types';
const m=vi.hoisted(()=>({write:vi.fn(),event:vi.fn(),report:vi.fn()}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,work:(tx:unknown)=>unknown)=>work({insert:()=>({values:(value:unknown)=>{m.write(value);return {onConflictDoUpdate:()=>({returning:async()=>[{id:'fictional-schedule'}]})};}})})}));
vi.mock('../db/events',()=>({appendEvent:m.event,actorOf:()=>({kind:'user'})}));
vi.mock('../core/employee-master-reports',()=>({getEmployeeMasterReport:m.report,getExecutableEmployeeMasterReport:m.report,authorizeEmployeeMasterRun:vi.fn(),runEmployeeMasterReport:vi.fn()}));
vi.mock('../core/employee-master-access',()=>({MasterReportAccessError:class extends Error{}}));
vi.mock('../core/notification-email',()=>({resolveEmployeeMasterRecipients:vi.fn()}));
vi.mock('../lib/employee-master-export',()=>({serializeEmployeeMaster:vi.fn()}));
vi.mock('../lib/employee-master-field-labels',()=>({employeeMasterFieldLabels:vi.fn()}));
import {reportAcceptanceEnvironmentProjection} from '../scripts/managed-report-acceptance-model';
import {employeeMasterScheduledEmailEnabled} from '../lib/employee-master-scheduled-email';
import {saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ctx={tenantId:id(1),userId:id(2),personId:id(3),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
const pair={userId:id(4),employmentId:id(5)},input={reportId:id(6),version:1,enabled:true,config:{frequency:'weekly' as const,day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[pair]};
const web={AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://localhost:3543',AUTH_SESSION_KEY:'a'.repeat(64),DATABASE_URL:'postgres://ai_hr_app:fictional-app@127.0.0.1:5432/ai_hr_report_delivery_acceptance'};
const policy=vi.fn(async()=>[{...pair,context:ctx,scopeIds:[id(7)],label:'Fictional recipient'}] as unknown as MasterRecipient[]);
beforeEach(()=>{vi.clearAllMocks();m.report.mockResolvedValue({id:input.reportId,canEdit:true,version:1,spec:{companyIds:[id(7)]},shared:true,sharedRoleIds:['hr_admin']});});
afterEach(()=>vi.unstubAllEnvs());
describe('acceptance projection to canonical schedule writer capability',()=>{
 it.each(['true','false'] as const)('preserves verified-web %s through the fixture projection to actual admission',async flag=>{
  const plan=reportAcceptanceEnvironmentProjection({},Object.freeze({...web,EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:flag}),'postgres://fictional_owner:fictional-owner@127.0.0.1:5432/ai_hr_report_delivery_acceptance');
  const target:Record<string,string|undefined>={};for(const key of plan.clear)Reflect.deleteProperty(target,key);Object.assign(target,plan.assign);
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',target.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED);
  if(flag==='true'){
   // On shipping b39 this reaches the genuine canonical Unavailable refusal, not import failure.
   await expect(saveEmployeeMasterSchedule(ctx,[id(7)],input,policy)).resolves.toEqual({id:'fictional-schedule'});
   expect(m.write).toHaveBeenCalledWith(expect.objectContaining({enabled:true,nextRunAt:expect.any(Date)}));expect(m.event).toHaveBeenCalledTimes(1);expect(policy).toHaveBeenCalledTimes(1);
  }else{
   await expect(saveEmployeeMasterSchedule(ctx,[id(7)],input,policy)).rejects.toThrow(/unavailable/i);expect(m.write).not.toHaveBeenCalled();expect(m.event).not.toHaveBeenCalled();expect(policy).not.toHaveBeenCalled();
  }
  expect(employeeMasterScheduledEmailEnabled(target)).toBe(flag==='true');expect(target.EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED).toBe(flag);
 });
});
