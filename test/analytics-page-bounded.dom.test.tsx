import {beforeEach, expect, it, vi} from 'vitest';
import {render, screen, within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {pageState, parsePageQuery} from '../lib/pagination';

const ports=vi.hoisted(()=>({hires:vi.fn(),terms:vi.fn(),changes:vi.fn(),carry:vi.fn(),count:vi.fn(),manager:vi.fn(),filters:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'tenant',userId:'caller'},scopeIds:['company']})}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('../core/read',()=>({listCompanies:async()=>[],listDepartments:async()=>[]}));
vi.mock('../core/admin',()=>({listCostCenters:async()=>[]}));
vi.mock('../core/analytics',()=>({
  analyticsDateRange:(get:(key:string)=>string|undefined)=>({from:get('from')??'2026-01-01',to:get('to')??'2026-12-31'}),
  parseAnalyticsFilters:(get:(key:string)=>string|undefined)=>({departmentId:get('departmentId'),q:get('q'),companyId:get('companyId'),managerEmploymentId:get('managerEmploymentId')}),
  parseReportYear:()=>2026,
  headcountSummary:async()=>({total:40000,byCompany:[],byDepartment:[],byPosition:[]}),
  newHiresPage:ports.hires,terminationsPage:ports.terms,changeJobTransactionsPage:ports.changes,carryForwardReportPage:ports.carry,
  masterDataCount:ports.count,analyticsManagerSelection:ports.manager,
  turnoverRateFiltered:async()=>({turnoverPct:1,leavers:100,headcountStart:40000,headcountEnd:40000}),
  workforceDemographics:async()=>({byGender:[],byMarital:[],byAgeBand:[],byDepartment:[],byLocation:[],byCostCentre:[],byEmploymentStatus:[]}),
  demographicsByNationality:async()=>[],leaveUtilisation:async()=>[],leaveBalancesSummary:async()=>[],
  sickLeaveTrend:async()=>({configured:true,series:[]}),movementByMonth:async()=>[],
}));
vi.mock('../app/analytics/FilterBar',()=>({FilterBar:(props:unknown)=>{ports.filters(props);return <div>report filters</div>;}}));
vi.mock('../app/analytics/YearSelect',()=>({YearSelect:()=>null}));
vi.mock('../app/analytics/labels',()=>({bucketLabel:(name:string)=>name,localizeDimension:()=>({categories:[],values:[]})}));
vi.mock('../components/assistant/protected-analysis',()=>({ProtectedAnalysis:()=>null}));
vi.mock('../components/ui',()=>({
  Card:({children}:{children:ReactNode})=><section>{children}</section>,
  PageHeader:({title}:{title:string})=><h1>{title}</h1>,
  SectionHeader:({title,count}:{title:string;count?:number})=><h2>{title}{count!==undefined&&' '+count}</h2>,
}));
vi.mock('../components/charts/BarChart',()=>({BarChart:()=>null}));
vi.mock('../components/charts/PieChart',()=>({PieChart:()=>null}));
vi.mock('../components/charts/LineChart',()=>({LineChart:()=>null}));
vi.mock('../components/charts/ChartCard',()=>({ChartCard:()=>null}));
vi.mock('../components/pager',()=>({Pager:({state,paramNames,params,exportHref}:{state:{total:number};paramNames:{page:string;size:string};params:Record<string,string>;exportHref:string})=>
  <div data-testid={paramNames.page} data-total={state.total} data-size={paramNames.size} data-manager={params.managerEmploymentId}><a href={exportHref}>complete export</a></div>}));
import AnalyticsPage from '../app/analytics/page';

const scopedManager={employmentId:'deep-manager',name:'Selected beyond the first page'};
const params={from:'2026-01-01',to:'2026-12-31',companyId:'company',departmentId:'department',q:'Alpha %',managerEmploymentId:'deep-manager',
  hirePage:'2',hireSize:'25',termPage:'3',termSize:'50',changePage:'4',changeSize:'100',carryPage:'5',carrySize:'200'};
beforeEach(()=>{
  vi.clearAllMocks();ports.manager.mockResolvedValue(scopedManager);ports.count.mockResolvedValue(50000);
  const result=(kind:string,n:number,total:number,page:{page:number;size:'all'|25|50|100|200;limit:number;offset:number})=>({
    rows:Array.from({length:n},(_,i)=>({name:kind+' '+i,employeeName:kind+' '+i,company:'company',department:'department',hiredOn:'2026-02-01',terminatedOn:'2026-03-01',
      terminationType:null,terminationReason:null,fromDepartment:'before',toDepartment:'after',fromPosition:null,toPosition:null,effectiveOn:'2026-04-01',
      carried:2,carryForwardExpiryDate:null,forfeitedAtOpen:0,forfeitedAtExpiry:0,reasonCodes:[]})),state:pageState(page,total,n)});
  ports.hires.mockImplementation(async(_s,_scope,p)=>result('Hire',25,50000,p.page));
  ports.terms.mockImplementation(async(_s,_scope,p)=>result('Termination',50,10000,p.page));
  ports.changes.mockImplementation(async(_s,_scope,p)=>result('Change',100,20000,p.page));
  ports.carry.mockImplementation(async(_s,_scope,p)=>result('Carry',200,40000,p.page));
});

it('renders exact totals and bounded native report pages with independent pagers and complete export links',async()=>{
  render(await AnalyticsPage({searchParams:Promise.resolve(params)}));
  expect(screen.getByRole('heading',{name:'newHiresTitle 50000'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'terminationsTitle 10000'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'changeJobsTitle 20000'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'carryForwardTitle 40000'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'masterDataTitle 50000'})).toBeInTheDocument();
  for(const [port,prefix,size] of [[ports.hires,'hire','25'],[ports.terms,'term','50'],[ports.changes,'change','100'],[ports.carry,'carry','200']] as const){
    const passed=port.mock.calls[0][2];
    expect(passed.page).toEqual(parsePageQuery({page:params[(prefix+'Page') as keyof typeof params],size}));
    expect(passed.filter).toEqual({departmentId:'department',q:'Alpha %'});
    const pager=screen.getByTestId(prefix+'Page');
    expect(pager).toHaveAttribute('data-size',prefix+'Size');expect(pager).toHaveAttribute('data-manager','deep-manager');
    const href=within(pager).getByRole('link').getAttribute('href')!;
    expect(new URL(href,'https://fictional.invalid').searchParams.get('q')).toBe('Alpha %');
    expect(href).not.toContain('Page=');
  }
  expect(ports.filters.mock.calls[0][0].managerSelection).toEqual(scopedManager);
  expect(ports.filters.mock.calls[0][0].options).not.toHaveProperty('managers');
  expect(screen.getAllByRole('row')).toHaveLength(25+50+100+200+4);
  expect(ports.count).toHaveBeenCalledWith(expect.anything(),['company'],{filter:{departmentId:'department',q:'Alpha %'}});
});
