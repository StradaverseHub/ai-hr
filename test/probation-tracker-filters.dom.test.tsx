import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {TrackerFilterPanel} from '../app/lifecycle/probation/tracker-filter-panel';
import {ProbationTracker} from '../app/lifecycle/probation/tracker';
import {trackerFilters} from '../app/lifecycle/probation/tracker-filters';
import type {probationSummaryRows} from '../packs/probation/service';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const options={businessGroups:[{id:'g1',name:'Group One'},{id:'g2',name:'Group Two'}],businessUnits:[{id:'u1',name:'Unit One'},{id:'u2',name:'Unit Two'}],departments:[{id:'d1',name:'Department One'},{id:'d2',name:'Department Two'}],grades:['12','15'],pbps:[],states:[],facets:[{businessGroupId:'g1',businessUnitId:'u1',departmentId:'d1',grade:'12'},{businessGroupId:'g2',businessUnitId:'u2',departmentId:'d2',grade:'15'}]};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('complete Probation tracker filters',()=>{
 it('cascades visible-case choices and submits five filters with the selected summary flag',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><TrackerFilterPanel options={options} filters={{flag:'overdue'}} configure={false}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByRole('combobox',{name:en.probation.facts.businessGroup}),{target:{value:'g1'}});
  expect(screen.queryByRole('option',{name:'Unit Two'})).toBeNull();expect(screen.queryByRole('option',{name:'Department Two'})).toBeNull();expect(screen.queryByRole('option',{name:'15'})).toBeNull();
  const form=screen.getByRole('button',{name:en.probation.applyFilters}).closest('form')!;
  expect([...new FormData(form).keys()].sort()).toEqual(['businessGroupId','businessUnitId','departmentId','flag','grade','search']);
  expect(new FormData(form).get('flag')).toBe('overdue');
 });
 it('debounces suggestions and discards a response to an obsolete name',async()=>{
  let oldReply!:(value:unknown)=>void;
  const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{oldReply=resolve;})).mockResolvedValueOnce({ok:true,json:async()=>({names:['Bob Workshop']})});vi.stubGlobal('fetch',fetcher);
  render(<NextIntlClientProvider locale="en" messages={en}><TrackerFilterPanel options={options} filters={{}} configure={false}/></NextIntlClientProvider>);
  const input=screen.getByRole('combobox',{name:en.probation.tracker.search});fireEvent.change(input,{target:{value:'ali'}});await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  fireEvent.change(input,{target:{value:'bob'}});oldReply({ok:true,json:async()=>({names:['Alice Private']})});await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(document.querySelector('option[value="Bob Workshop"]')).not.toBeNull());expect(document.querySelector('option[value="Alice Private"]')).toBeNull();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
 });
 it('removes obsolete PBP/state dropdown parameters for both screen and export readers',()=>{
  expect(trackerFilters({search:'  Alice  ',pbpUserId:'11111111-1111-1111-1111-111111111111',state:'in_review',flag:'overdue'})).toMatchObject({search:'Alice',flag:'overdue'});
  expect(trackerFilters({state:'in_review'})).not.toHaveProperty('state');expect(trackerFilters({pbpUserId:'11111111-1111-1111-1111-111111111111'})).not.toHaveProperty('pbpUserId');
 });
 it.each([['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const)('preserves full tracker and counted summary tiles in %s',async(locale,messages)=>{
  const data={options,total:1,offset:0,limit:50,hasMore:false,totals:{overdue:1,end_passed:0,ending14:1,low_result:0,kpi_submit:0,kpi_ack:1},rows:[{id:'case-one',employmentId:'employee',companyId:'u1',revision:1,employeeName:'Fictional Alice Workshop',employeeCode:'F001',title:'Project Coordinator',businessGroupId:'g1',businessGroup:'Group One',businessUnitId:'u1',businessUnit:'Unit One',departmentId:'d1',department:'Department One',pbpUserId:null,grade:'12',startOn:'2026-06-01',endOn:'2026-11-15',planMonths:6,planFlag:false,extensionCount:0,state:'in_review',kpiAcknowledged:false,canOpen:true,letterWaiting:null,parts:[{id:'part-one',type:3,cycle:0,state:'issued',dueOn:'2026-11-01',managerSubmittedAt:null,staffSubmittedAt:null,acknowledgedAt:null,scoreBand:null,override:false,waitingRole:'lm',waitingName:'Fictional Manager',calendarDaysOverdue:3}]}]} satisfies Awaited<ReturnType<typeof probationSummaryRows>>;
  render(<NextIntlClientProvider locale={locale} messages={messages}><div className="v9-workspace probation"><ProbationTracker data={data} filters={{flag:'overdue',search:'Alice'}} configure/></div></NextIntlClientProvider>);
  for(const key of ['employee','stage','plan','endOn','extensions','waiting','due','flags','action'] as const)expect(screen.getByRole('columnheader',{name:messages.probation.columns[key]})).toBeVisible();
  expect(screen.getByRole('link',{name:messages.probation.open})).toHaveAttribute('href','/lifecycle/probation/case-one');
  expect(document.querySelectorAll('.probation-stats a[data-flag]')).toHaveLength(6);expect(document.querySelector('.probation-stats a[aria-current="page"]')).toHaveAttribute('data-flag','overdue');
  expect(screen.getByRole('link',{name:messages.probation.export})).toHaveAttribute('href',expect.stringContaining('flag=overdue'));
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'probation-tracker','Actual complete tracker and five-filter panel; fictional saved case facts; not authenticated acceptance','atelier');
 },120000);
});
