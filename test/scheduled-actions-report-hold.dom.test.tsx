import React from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import type {JobRunRow} from '../core/job-run';

const state=vi.hoisted(()=>({locale:'en',session:vi.fn(),runs:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:state.session}));
// Use the real permission predicate without importing unrelated entitlement readers.
vi.mock('../lib/authz',()=>import('../lib/authz-model'));
vi.mock('../db/client',()=>({withTenant:vi.fn(),createDb:vi.fn()}));
vi.mock('../core/job-run',async importOriginal=>({
 ...await importOriginal<typeof import('../core/job-run')>(),listRecentJobRuns:state.runs,
}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('next-intl/server',()=>({
 getLocale:async()=>state.locale,
 getTranslations:async(namespace:string)=>createTranslator({locale:state.locale,namespace,messages:JSON.parse(readFileSync(join(process.cwd(),'messages',`${state.locale}.json`),'utf8')),onError:error=>{throw error;}}),
}));
import Page from '../app/(app)/admin/scheduled-actions/page';
import {JOBS} from '../core/job-run';

const catalog=(locale:string)=>JSON.parse(readFileSync(join(process.cwd(),'messages',`${locale}.json`),'utf8'));
const reportJob=JOBS.find(job=>job.key==='reports.employee-master.deliver')!;
const admin={tenantId:'fictional-tenant',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const historicalRun:JobRunRow={id:'fictional-run',jobKey:reportJob.key,ranAt:new Date(Date.now()-3600_000),durationMs:1500,outcome:'success',tenantsProcessed:1,tenantsFailed:0,result:{sent:2},error:null};
function reportCard(messages:ReturnType<typeof catalog>){
 const card=screen.getByText(messages.scheduledActions.jobs[reportJob.i18nKey].name).closest('details');
 expect(card).not.toBeNull();
 return card!;
}
beforeEach(()=>{vi.clearAllMocks();state.locale='en';state.session.mockResolvedValue(admin);state.runs.mockResolvedValue([historicalRun]);vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',undefined);});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});

describe('Scheduled Actions respects the report email release hold',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('shows held availability in %s while retaining report history and other schedules',async locale=>{
  state.locale=locale;const messages=catalog(locale);render(await Page());
  const card=reportCard(messages),view=within(card);
  expect(view.getByText(messages.employeeMasterReports.schedule.unavailable)).toBeTruthy();
  expect(card.textContent).not.toContain(reportJob.schedule);
  // Historical work remains visible even though future delivery is currently unavailable.
  const history=view.getByRole('table',{hidden:true});
  expect(within(history).getAllByRole('row',{hidden:true})).toHaveLength(2);
  expect(within(history).getByText(messages.scheduledActions.outcome.success)).toBeTruthy();
  for(const job of JOBS.filter(job=>job.key!==reportJob.key)){
   const other=screen.getByText(messages.scheduledActions.jobs[job.i18nKey].name).closest('details');
   expect(other?.textContent).toContain(job.schedule);
  }
  expect(card.querySelectorAll('button,input,select,form')).toHaveLength(0);
  expect(state.runs).toHaveBeenCalledWith(admin,10);
 });
 it('restores the ordinary frequency only for exact explicit opt-in',async()=>{
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');const messages=catalog('en');render(await Page());
  const card=reportCard(messages);
  expect(card.textContent).toContain(reportJob.schedule);
  expect(card.textContent).not.toContain(messages.employeeMasterReports.schedule.unavailable);
  expect(within(card).getByRole('table',{hidden:true})).toBeTruthy();
 });
 it.each(['false','TRUE','1',' true','true '])('keeps nonexact capability %s unavailable',async value=>{
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',value);const messages=catalog('en');render(await Page());
  const card=reportCard(messages);
  expect(card.textContent).toContain(messages.employeeMasterReports.schedule.unavailable);
  expect(card.textContent).not.toContain(reportJob.schedule);
 });
 it('retains the group-admin page gate before reading job history',async()=>{
  state.session.mockResolvedValue({...admin,grants:[{role:'hr_admin',companyId:'fictional-company'}]});
  await expect(Page()).rejects.toThrow('REDIRECT /');expect(state.runs).not.toHaveBeenCalled();
 });
});
