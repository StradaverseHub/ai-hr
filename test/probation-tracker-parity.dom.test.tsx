/** Lane M1: the Probation tracker and Personnel postings follow the approved prototype (Tracker, Flags, PostingsPage):
 * header, Personnel sync banner, seven coloured tiles, filter card with source hints and Show closed cases, the case count
 * and the prototype's table columns, cells and row tint. Fixtures are fictional. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
import en from '../messages/en.json';
import {ProbationTracker} from '../app/lifecycle/probation/tracker';
import {trackerFilters} from '../app/lifecycle/probation/tracker-filters';
import {trackerPlanParts,trackerRowAttention,trackerRowFlags,trackerWaitingStep} from '../app/lifecycle/probation/tracker-row';
import {PostingsTable,type PostingTableRow} from '../app/lifecycle/probation/postings/postings-table';
import type {probationSummaryRows,ProbationSummaryRow} from '../packs/probation/service';

vi.mock('next/link',()=>({__esModule:true,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 default:({href,children,prefetch:_prefetch,...rest}:any)=><a href={typeof href==='string'?href:String(href)} {...rest}>{children}</a>}));
afterEach(()=>{cleanup();});
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en} onError={e=>{throw e;}}><div className="v9-workspace probation">{node}</div></NextIntlClientProvider>);
const TODAY='2026-11-16';
type Part=ProbationSummaryRow['parts'][number];
const part=(over:Partial<Part>):Part=>({id:'part-3',type:3,cycle:1,state:'issued',dueOn:'2026-11-13',managerSubmittedAt:null,staffSubmittedAt:'2026-11-10T00:00:00Z',acknowledgedAt:null,scoreBand:null,override:false,waitingRole:'lm',waitingName:'Fictional Manager',...over});
const row=(over:Partial<ProbationSummaryRow>):ProbationSummaryRow=>({id:'case-one',employmentId:'employment-one',companyId:'company-one',revision:1,employeeName:'Fictional Alice Workshop',employeeCode:'F001',title:'Project Coordinator',
 businessGroupId:'g1',businessGroup:'Fictional Group',businessUnitId:'u1',businessUnit:'Fictional Unit',departmentId:'d1',department:'Fictional Sales',pbpUserId:null,grade:'12',startOn:'2026-05-15',endOn:'2026-11-15',
 planMonths:6,planFlag:false,extensionCount:1,extensionMax:2,action:'log_followup',startStatus:null,state:'in_review',kpiAcknowledged:true,canOpen:true,letterWaiting:null,lowBand:2,
 parts:[part({id:'part-1',type:1,state:'locked',managerSubmittedAt:'2026-05-20T00:00:00Z',acknowledgedAt:'2026-05-21T00:00:00Z',waitingRole:null,waitingName:null}),part({id:'part-2',type:2,state:'locked',scoreBand:2,waitingRole:null,waitingName:null,lowResultActioned:false}),part({calendarDaysOverdue:3})],...over});
const options={businessGroups:[{id:'g1',name:'Fictional Group'}],businessUnits:[{id:'u1',name:'Fictional Unit'}],departments:[{id:'d1',name:'Fictional Sales'}],grades:['12'],pbps:[],states:[],facets:[{businessGroupId:'g1',businessUnitId:'u1',departmentId:'d1',grade:'12'}]};
const page=(rows:ProbationSummaryRow[],over:Partial<Awaited<ReturnType<typeof probationSummaryRows>>>={}):Awaited<ReturnType<typeof probationSummaryRows>>=>({options,total:rows.length,offset:0,limit:50,hasMore:false,
 totals:{overdue:3,end_passed:1,ending14:3,low_result:2,kpi_submit:1,kpi_ack:0,overridden:0},rows,...over});
const tr=en.probation.tracker;

describe('Probation tracker in the prototype layout',()=>{
 it('shows the header, sync banner, the seven tiles with their colours and the filter card with source hints',()=>{
  wrap(<ProbationTracker data={page([row({})])} filters={{flag:'overdue'}} configure={false} today={TODAY}/>);
  expect(screen.getByText(tr.breadcrumb)).toBeVisible();
  expect(screen.getByRole('heading',{level:1,name:tr.title})).toBeVisible();
  expect(screen.getByText(tr.intro)).toBeVisible();
  expect(screen.getByRole('link',{name:en.probation.export})).toHaveAttribute('href',expect.stringContaining('flag=overdue'));
  expect(screen.queryByRole('link',{name:tr.links.settings})).toBeNull();
  const banner=screen.getByTestId('probation-sync-banner');
  expect(banner).toHaveTextContent('Synced from Personnel Management. Every employee whose status is Probation gets a case here automatically');
  expect(within(banner).getByText('Probation').tagName).toBe('B');
  const tiles=[...document.querySelectorAll<HTMLAnchorElement>('.pct-tiles a.pct-tile')];
  expect(tiles.map(tile=>tile.dataset.flag)).toEqual(['overdue','end_passed','ending14','low_result','kpi_submit','kpi_ack','overridden']);
  expect(tiles.map(tile=>tile.querySelector('span')!.textContent)).toEqual(['Overdue steps','End passed, no outcome','Ending within 14 days',tr.tiles.low_result,'KPIs not submitted','KPIs not acknowledged','Suggestion overridden']);
  expect(tiles.map(tile=>tile.dataset.tone)).toEqual(['bad','bad','warn','warn','warn','warn','plain']);
  expect(tiles.map(tile=>tile.querySelector('b')!.textContent)).toEqual(['3','1','3','2','1','0','0']);
  expect(tiles[0]).toHaveAttribute('aria-current','page');expect(tiles[0].getAttribute('href')).not.toContain('flag=');
  expect(tiles[2].getAttribute('href')).toContain('flag=ending14');
  for(const [name,hint] of [[tr.search,tr.hints.search],[en.probation.facts.businessGroup,tr.hints.businessGroup],[en.probation.facts.businessUnit,tr.hints.businessUnit],[en.probation.facts.department,tr.hints.department],[tr.gradeAtStart,tr.hints.grade]] as const)
   expect(screen.getByRole('combobox',{name})).toHaveAccessibleDescription(hint);
  expect(screen.getByRole('combobox',{name:tr.search})).toHaveAttribute('placeholder',tr.namePlaceholder);
  expect(screen.getByRole('button',{name:en.probation.applyFilters})).toBeVisible();
  expect(screen.getByRole('link',{name:en.probation.clearFilters})).toHaveAttribute('href','/lifecycle/probation');
  expect(screen.getByText('1 of 1 cases · filtered by “Overdue steps”')).toBeVisible();
 });
 it('Show closed cases is ticked by default and, unticked, submits hideClosed for the list and Export',()=>{
  wrap(<ProbationTracker data={page([row({})])} filters={{}} configure={false} today={TODAY}/>);
  const box=screen.getByRole('checkbox',{name:tr.showClosed}),form=box.closest('form')!;
  expect(box).toBeChecked();expect(new FormData(form).has('hideClosed')).toBe(false);
  fireEvent.click(box);expect(box).not.toBeChecked();expect(new FormData(form).get('hideClosed')).toBe('1');
  expect(trackerFilters({hideClosed:'1'}).hideClosed).toBe(true);expect(trackerFilters({}).hideClosed).toBeUndefined();
  cleanup();
  wrap(<ProbationTracker data={page([row({})])} filters={trackerFilters({hideClosed:'1'})} configure={false} today={TODAY}/>);
  expect(screen.getByRole('checkbox',{name:tr.showClosed})).not.toBeChecked();
  expect(screen.getByRole('link',{name:en.probation.export}).getAttribute('href')).toContain('hideClosed=true');
 });
 it('renders the prototype columns and cells, with the overdue row tinted',()=>{
  wrap(<ProbationTracker data={page([row({})])} filters={{}} configure today={TODAY}/>);
  expect(screen.getAllByRole('columnheader').map(th=>th.textContent)).toEqual(['Employee','Business group · unit','Probation end','Review plan','Stage','Waiting on','Due','Flags','Ext.','Action']);
  expect(screen.getByRole('columnheader',{name:'Ext.'}).querySelector('abbr')).toHaveAttribute('title',tr.columns.extensionsFull);
  const line=document.querySelector('tr[data-case="case-one"]') as HTMLElement;
  expect(line).toHaveClass('pct-hl');
  const cells=within(line).getAllByRole('cell');
  expect(within(cells[0]).getByRole('link',{name:'Fictional Alice Workshop'})).toHaveAttribute('href','/lifecycle/probation/case-one');
  expect(cells[0]).toHaveTextContent('F001 · 12 · Project Coordinator');
  expect(cells[1]).toHaveTextContent('Fictional GroupFictional Unit · Fictional Sales');
  expect(cells[2]).toHaveTextContent('15-Nov-2026');
  expect(cells[3]).toHaveTextContent('6 monthsPart 2 + Part 3');
  expect(cells[4]).toHaveTextContent('Part 3 Final review');
  expect(cells[5]).toHaveTextContent('Line Manager · Fictional Manager · assessment');
  expect(within(cells[6]).getByText('3 calendar days overdue').tagName).toBe('B');
  expect([...cells[7].querySelectorAll('.pct-pill')].map(p=>[p.textContent,(p as HTMLElement).dataset.tone])).toEqual([['End date passed','bad'],['Band 2 · low result','bad']]);
  expect(cells[8]).toHaveTextContent('1 / 2');
  expect(within(cells[9]).getByRole('link',{name:tr.actions.log_followup})).toHaveAttribute('href','/lifecycle/probation/case-one');
  expect(screen.getByRole('link',{name:tr.links.settings})).toHaveAttribute('href','/lifecycle/probation/settings');
  expect(screen.getByRole('link',{name:tr.links.intake})).toHaveAttribute('href','/lifecycle/probation/intake');
 });
 it('shows closed, waiting-to-start and KPI rows the prototype way, and the empty state',()=>{
  wrap(<ProbationTracker data={page([
   row({id:'closed',state:'confirmed',action:'open',parts:[]}),
   row({id:'waiting',startStatus:'waiting_for_start',startOn:'2026-12-01',endOn:'2027-06-01',action:'open',planMonths:3,parts:[part({id:'w1',type:1,state:'not_issued',dueOn:'2026-12-08',waitingRole:null,waitingName:null}),part({id:'w2',type:2,state:'cancelled'}),part({id:'w3',type:3,state:'not_issued',waitingRole:null})]}),
   row({id:'kpi',endOn:'2026-11-25',action:'open',parts:[part({id:'k1',type:1,state:'issued',dueOn:'2026-11-20',managerSubmittedAt:null,staffSubmittedAt:null,waitingRole:'lm'}),part({id:'k3',type:3,state:'not_issued'})]}),
  ])} filters={{}} configure={false} today={TODAY}/>);
  const closed=document.querySelector('tr[data-case="closed"]') as HTMLElement,waiting=document.querySelector('tr[data-case="waiting"]') as HTMLElement,kpi=document.querySelector('tr[data-case="kpi"]') as HTMLElement;
  expect(within(closed).getByText('Confirmed')).toHaveAttribute('data-tone','ok');expect(closed).not.toHaveClass('pct-hl');
  expect(within(waiting).getAllByRole('cell')[4]).toHaveTextContent('Waiting for start date');
  expect(within(waiting).getAllByRole('cell')[5]).toHaveTextContent('Start date 01-Dec-2026');
  expect(within(waiting).getAllByRole('cell')[3]).toHaveTextContent('3 monthsPart 3 only');
  expect(within(kpi).getAllByRole('cell')[4]).toHaveTextContent('Week 1 KPIs');
  expect(within(kpi).getAllByRole('cell')[5]).toHaveTextContent('Line Manager · Fictional Manager · KPI submission');
  expect(within(kpi).getAllByRole('cell')[6]).toHaveTextContent('20-Nov-2026');
  expect([...within(kpi).getAllByRole('cell')[7].querySelectorAll('.pct-pill')].map(p=>p.textContent)).toEqual(['Ends within 14 days','KPIs not submitted']);
  cleanup();
  wrap(<ProbationTracker data={page([])} filters={{}} configure={false} today={TODAY}/>);
  expect(screen.getByText(tr.empty)).toBeVisible();expect(screen.getByText('0 of 0 cases')).toBeVisible();
 });
 it('derives pills, tint, plan parts and the waiting step from the summary row alone',()=>{
  expect(trackerRowFlags(row({parts:[part({override:true,scoreBand:1,lowResultActioned:true})]}),TODAY).map(f=>f.key)).toEqual(['end_passed','low_result','overridden','low_actioned']);
  expect(trackerRowFlags(row({endOn:'2027-03-01',planFlag:true,parts:[part({type:1,managerSubmittedAt:'2026-11-01T00:00:00Z',acknowledgedAt:null})]}),TODAY).map(f=>f.key)).toEqual(['kpi_ack','plan_review']);
  expect(trackerRowFlags(row({state:'withdrawn'}),TODAY)).toEqual([]);
  expect(trackerRowAttention(row({endOn:'2027-03-01',parts:[part({dueOn:'2026-12-01'})]}),TODAY)).toBe(false);
  expect(trackerRowAttention(row({endOn:'2027-03-01'}),TODAY)).toBe(true);
  expect(trackerPlanParts(row({parts:[part({type:2,state:'cancelled'}),part({type:3})]}))).toEqual([3]);
  expect(trackerWaitingStep(part({type:2,waitingRole:'employee',staffSubmittedAt:null}))).toBe('self');
  expect(trackerWaitingStep(part({type:2,waitingRole:'employee',managerSubmittedAt:'2026-11-01T00:00:00Z'}))).toBe('acknowledge');
  expect(trackerWaitingStep(part({type:3,waitingRole:'hod',managerSubmittedAt:'2026-11-01T00:00:00Z',acknowledgedAt:'2026-11-02T00:00:00Z'}))).toBe('approval');
 });
});

const posting=(over:Partial<PostingTableRow>):PostingTableRow=>({id:'00000000-0000-4000-8000-000000001041',label:'PP-1041',employmentId:'emp-nur',employeeName:'Fictional Nur',employeeCode:'F002',source:'probation',
 eventType:'confirmation',proposed:{effectiveDate:'2026-11-03'},edited:null,current:{effectiveDate:'2026-11-03'},displayStatus:'pending',editedBy:null,editedAt:null,approvedBy:null,approvedAt:null,
 approverGroupName:'Fictional People Ops',createdAt:'2026-11-02T08:00:00Z',revision:1,canApprove:true,canEdit:true,...over});
describe('Personnel postings in the prototype layout',()=>{
 it('has the prototype columns, the From pill, status pills and Approve before Edit',()=>{
  wrap(<PostingsTable approveAction={vi.fn()} rows={[posting({}),posting({id:'00000000-0000-4000-8000-000000001040',label:'PP-1040',displayStatus:'approved',approvedBy:{name:'Fictional Siteng'},approvedAt:'2026-11-03T08:00:00Z'})]}/>);
  expect(screen.getAllByRole('columnheader').map(th=>th.textContent)).toEqual(['Posting','Employee','From','Event type','Change','Created','Status',en.personnelPostings.columns.actions]);
  const pending=document.querySelector('tr[data-posting="PP-1041"]') as HTMLElement,approved=document.querySelector('tr[data-posting="PP-1040"]') as HTMLElement;
  expect(within(pending).getByText('Probation')).toHaveClass('pct-pill');
  expect(within(pending).getByText('Pending')).toHaveAttribute('data-tone','warn');
  expect(within(approved).getByText('Approved')).toHaveAttribute('data-tone','ok');
  const actions=within(pending).getAllByRole('button').concat(within(pending).getAllByRole('link'));
  expect(actions.map(a=>a.textContent)).toEqual(['Approve','Edit']);
  expect(within(pending).getByRole('button',{name:'Approve'}).compareDocumentPosition(within(pending).getByRole('link',{name:'Edit PP-1041 in Personnel Management'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });
 it('keeps the empty state inside the table',()=>{
  wrap(<PostingsTable approveAction={vi.fn()} rows={[]}/>);
  expect(screen.getByRole('cell',{name:en.personnelPostings.empty})).toBeVisible();
 });
});
