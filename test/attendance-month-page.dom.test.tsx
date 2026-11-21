import type {ReactNode} from 'react';
import {render,screen,within,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {pageState,parsePageQuery} from '../lib/pagination';
const ports=vi.hoisted(()=>({read:vi.fn(),module:vi.fn(),pager:vi.fn(),export:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('next/link',()=>({default:({href,children,...props}:{href:string;children:ReactNode})=><a href={href} {...props}>{children}</a>}));
vi.mock('../lib/authz',()=>({requireModule:ports.module}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture-tenant',userId:'fixture-user',roles:['hr_admin']},scopeIds:['fixture-company']})}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-05-19'}));
vi.mock('../packs/attendance/service',()=>({attendanceMonthSummaryPage:ports.read}));
vi.mock('../components/ui',()=>({
 Card:({children,...props}:{children:ReactNode})=><section {...props}>{children}</section>,
 EmployeeName:({name,code}:{name:string;code:string|null})=><span>{code} {name}</span>,
 ErrorBanner:()=>null,PageHeader:({title,actions}:{title:string;actions:ReactNode})=><header><h1>{title}</h1>{actions}</header>,pageWideCls:'wide',
}));
vi.mock('../components/attendance-tabs',()=>({AttendanceTabs:()=> <nav>overview tab</nav>}));
vi.mock('../components/ot-report-export',()=>({OtReportExport:(props:unknown)=>{ports.export(props);return <button>complete overtime export</button>;}}));
vi.mock('../components/pager',()=>({Pager:(props:{state:{total:number;limit:number;from:number;to:number}})=>{
 ports.pager(props);return <div data-testid="month-pager">{props.state.from}–{props.state.to} of {props.state.total}</div>;
}}));
vi.mock('../components/formula-overtime-record',()=>({OvertimeSummaryValue:({summary}:{summary:{knownMinutes:{numerator:string}}})=><span>stored minutes {summary.knownMinutes.numerator}</span>}));
import AttendancePage from '../app/attendance/page';
afterEach(cleanup);beforeEach(()=>{vi.clearAllMocks();ports.read.mockImplementation(async(_ctx,p)=>({
 rows:Array.from({length:25},(_,i)=>({employmentId:'known-'+i,name:'Known monthly employee '+i,employeeCode:'MONTH-'+i,present:7,late:1,halfDay:2,absent:3,leaveDays:4,workedMinutes:480,
  overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'121',denominator:'2'},complete:true},overtimeCapState:'within',over45hWeek:false})),
 state:pageState(p.page,40000,25),
}));});
it('renders the actual nine-column month grid with one bounded service and exact independent count/month/scope/page',async()=>{
 render(await AttendancePage({searchParams:Promise.resolve({month:'2026-04',page:'3',size:'25'})}));
 expect(ports.module).toHaveBeenCalledWith('attendance');expect(ports.read).toHaveBeenCalledTimes(1);
 expect(ports.read).toHaveBeenCalledWith(expect.objectContaining({tenantId:'fixture-tenant',userId:'fixture-user'}),{
  month:'2026-04',today:'2026-05-19',companyIds:['fixture-company'],page:parsePageQuery({page:'3',size:'25'}),
 });
 const table=screen.getByRole('table');expect(within(table).getAllByRole('columnheader')).toHaveLength(9);
 expect(within(table).getAllByRole('row')).toHaveLength(26);expect(screen.getByText('MONTH-0 Known monthly employee 0')).toBeTruthy();
 expect(screen.getByTestId('month-pager').textContent).toBe('76–100 of 40000');expect(screen.getAllByText('stored minutes 121')).toHaveLength(25);
 expect(ports.export).toHaveBeenCalledWith(expect.objectContaining({month:'2026-04'}));
 expect(screen.getByRole('link',{name:'previousMonth'}).getAttribute('href')).toBe('/attendance?month=2026-03');
 expect(screen.getByRole('link',{name:'nextMonth'}).getAttribute('href')).toBe('/attendance?month=2026-05');
});
