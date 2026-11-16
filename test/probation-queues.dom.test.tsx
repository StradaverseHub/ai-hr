/** Probation work in My Action Centre (lane E): the Approval Items category, the tracker filtered to the caller's work,
 *  and Today's grouped link. Fictional data only. */
import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'approvals'})}));
import {CategoryPanel} from '../app/approvals/category-panel';
import {APPROVAL_CATEGORIES,parseApprovalCategory,sectionVisible} from '../lib/approvals-categories';
import {ProbationTracker} from '../app/lifecycle/probation/tracker';
import {trackerFilters} from '../app/lifecycle/probation/tracker-filters';
import {taskGroupHref} from '../lib/today/admin';
import {PACK_TASK_KINDS} from '../lib/assigned-work';
import {HOME_TASK_KINDS} from '../lib/employee-home';
afterEach(cleanup);
const counts={leave:0,leaveCancellation:0,replacementLeave:0,attendance:0,overtime:0,claim:0,resignations:0,managerReviews:0,hrReviews:0,rewards:0,probation:3};
describe('Probation in Approval Items',()=>{
 it('is a people category any approver can open, showing its own section only',async()=>{
  expect(APPROVAL_CATEGORIES).toContain('probation');
  expect(parseApprovalCategory('probation',{admin:false})).toBe('probation');
  expect(sectionVisible('probation','probation')).toBe(true);expect(sectionVisible('probation','rewards')).toBe(false);expect(sectionVisible('all','probation')).toBe(true);
  render(await CategoryPanel({category:'probation',counts,allCount:3,admin:false}));
  const link=screen.getByRole('link',{name:new RegExp(en.approvals.probation+'.*3')});
  expect(link).toHaveAttribute('href','/approvals?category=probation');expect(link).toHaveAttribute('aria-current','page');
 });
 it('groups several Probation approvals on Today into the Approval Items category, and labels both kinds everywhere tasks are listed',()=>{
  expect(taskGroupHref('probationApproval',['/lifecycle/probation/a/b','/lifecycle/probation/c/d'],2)).toBe('/approvals?category=probation');
  expect(taskGroupHref('probationTask',['/lifecycle/probation/a/b'],1)).toBe('/lifecycle/probation/a/b');
  for(const kind of ['probationApproval','probationTask'] as const){
   expect(PACK_TASK_KINDS).toContain(kind);expect(HOME_TASK_KINDS).toContain(kind);
   expect(en.notifications.task[kind]).toBeTruthy();expect(en.employeeHome.taskNames[kind]).toBeTruthy();
  }
 });
});
describe('tracker filtered to the caller\'s work',()=>{
 it('reads mine from the link the queues use and offers a way back to every case',()=>{
  const filters=trackerFilters({mine:'1'});expect(filters.mine).toBe(true);expect(trackerFilters({}).mine).toBeUndefined();
  const data={options:{businessGroups:[],businessUnits:[],departments:[],grades:[],pbps:[],states:[],facets:[]},total:0,offset:0,limit:50,hasMore:false,totals:{overdue:0,end_passed:0,ending14:0,low_result:0,kpi_submit:0,kpi_ack:0,overridden:0},rows:[]} as unknown as Parameters<typeof ProbationTracker>[0]['data'];
  render(<NextIntlClientProvider locale="en" messages={en}><ProbationTracker data={data} filters={filters} configure={false}/></NextIntlClientProvider>);
  expect(screen.getByText(en.probation.tracker.mineOnly)).toBeVisible();
  expect(screen.getByRole('link',{name:en.probation.tracker.mineClear}).getAttribute('href')).not.toContain('mine');
 });
});
