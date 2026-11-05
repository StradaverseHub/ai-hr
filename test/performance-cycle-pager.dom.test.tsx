/** Rendered list totals use the native total, while row/privacy rendering remains page-local. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {pageState,parsePageQuery} from '../lib/pagination';
import {PerformanceCyclesAdmin,type CycleRow} from '../app/performance/onehr/admin-cycles';
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
// The pager's own DOM contract is tested separately; isolate this list's count/row/privacy boundary.
vi.mock('../components/pager',()=>({Pager:()=> <div data-testid="existing-pager"/>}));
vi.mock('../app/performance/new-cycle-form',()=>({NewCycleForm:()=> <div data-testid="existing-new-cycle-form"/>}));
afterEach(cleanup);
it('shows the exact full total with only the current page and keeps partner pay/creation controls withheld',async()=>{
 const row:CycleRow={id:'fictional-cycle',name:'Fictional paged cycle',companyId:null,periodStart:'2026-01-01',periodEnd:'2026-12-31',status:'draft',releasedAt:null,total:3,submitted:2,acknowledged:1};
 const element=await PerformanceCyclesAdmin({cycleCount:2101,rows:[row],pgState:pageState(parsePageQuery(),2101,1),basePath:'/performance',admin:false,companies:[],today:'2026-11-05'});
 render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
 expect(screen.getByText('(2101)')).toBeTruthy();expect(screen.getByText(row.name)).toBeTruthy();expect(screen.getAllByRole('row')).toHaveLength(2);
 expect(screen.queryByText(en.performance.list.colPendingPay)).toBeNull();expect(screen.queryByTestId('existing-new-cycle-form')).toBeNull();
});
it('renders the existing empty state from the exact total',async()=>{
 const element=await PerformanceCyclesAdmin({cycleCount:0,rows:[],pgState:pageState(parsePageQuery(),0,0),basePath:'/performance',admin:false,companies:[],today:'2026-11-05'});
 render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
 expect(screen.getByText(en.performance.list.noCycles)).toBeTruthy();expect(screen.queryByRole('table')).toBeNull();
});
