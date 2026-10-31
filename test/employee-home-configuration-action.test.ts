import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {HOME_TASK_KINDS,type EmployeeHomeConfiguration} from '../lib/employee-home';
import {locales} from '../i18n/config';
import {readEmployeeHomeConfigurationEditor} from '../core/employee-home-configuration';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,CALLER:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>CALLER}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
const {saveHomeConfigurationAction}=await import('../app/(app)/admin/settings/dashboard/home-actions');
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();CALLER=adminCtx(b);});
function form(configuration:EmployeeHomeConfiguration=defaultEmployeeHomeConfiguration(),companyId=b.companyId){
 const data=new FormData();
 for(const [key,value] of Object.entries({companyId,audienceRole:'employee',expectedOrdinal:'0',reason:'Fictional reviewed Home settings',teamVisibility:configuration.teamVisibility,celebrationsScope:configuration.celebrations.scope}))data.set(key,value);
 if(configuration.celebrations.enabled)data.set('celebrationsEnabled','on');
 for(const key of configuration.quickActions)data.append('quickAction',key);
 for(const kind of HOME_TASK_KINDS)data.set('effort.'+kind,configuration.effortMinutes[kind]?.toString()??'');
 for(const template of configuration.templates){
  if(template.enabled)data.set(`template.${template.key}.enabled`,'on');
  data.set(`template.${template.key}.priority`,String(template.priority));
  for(const locale of locales)data.set(`template.${template.key}.${locale}`,template.text[locale]);
 }
 return data;
}
describe('Home configuration server action authenticates and validates every save',()=>{
 it('saves the selected company/role once, confirms it, and refuses a stale resubmission',async()=>{
  const configuration=defaultEmployeeHomeConfiguration();configuration.quickActions=['profile','leave'];configuration.effortMinutes={leave:0,feedback:5};
  configuration.templates[0].enabled=false;
  const data=form(configuration),first=await saveHomeConfigurationAction({error:null},data);
  expect(first.error).toBeNull();const destination=new URL(first.destination!,'https://fixture.invalid');
  expect(destination.pathname).toBe('/admin/settings/dashboard');expect(destination.searchParams.get('homeCompanyId')).toBe(b.companyId);expect(destination.searchParams.get('homeRole')).toBe('employee');expect(destination.searchParams.get('toast')).toBe('saved');
  const readback=await readEmployeeHomeConfigurationEditor(CALLER,{companyId:b.companyId,audienceRole:'employee'});expect(readback.configuration).toEqual(configuration);expect(readback.ordinal).toBe(1);
  expect(await saveHomeConfigurationAction({error:null},data)).toEqual({error:'changed'});
  expect(await owner.db.select().from(s.employeeHomeConfigurationRevision)).toHaveLength(1);
 });
 it('refuses fields that claim authority, duplicate selectors, missing language text and unsafe placeholders',async()=>{
  const attempts=[form(),form(),form(),form(),form()];
  attempts[0].set('actorUserId',b.adminUserId);attempts[1].append('companyId',randomUUID());
  attempts[2].delete('template.greetingMorning.zh');attempts[3].set('template.greetingMorning.en','Private salary: {salary}');attempts[4].set('template.greetingMorning.priority','');
  for(const data of attempts)expect(await saveHomeConfigurationAction({error:null},data)).toEqual({error:'invalid'});
  expect(await owner.db.select().from(s.employeeHomeConfigurationRevision)).toEqual([]);
 });
 it('rechecks actual company scope when a permitted administrator posts a different company',async()=>{
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional scoped editor',primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  CALLER={tenantId:b.tenantId,userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional ungranted company'}).returning();
  expect(await saveHomeConfigurationAction({error:null},form(defaultEmployeeHomeConfiguration(),other.id))).toEqual({error:'forbidden'});
  expect(await owner.db.select().from(s.employeeHomeConfigurationRevision)).toEqual([]);
 });
});
