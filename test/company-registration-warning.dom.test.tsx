import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {CompanyRegistrationPreview} from './fixtures/company-registration-preview';
import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const {check}=vi.hoisted(()=>({check:vi.fn()}));
vi.mock('../app/payroll/process/registration-warning-action',()=>({checkRegistrationReadiness:check}));
import {CompanyRegistrationWarning} from '../app/payroll/process/registration-warning';
afterEach(()=>{cleanup();check.mockReset();});
const view=(id:string)=> <NextIntlClientProvider locale="en" messages={en}><CompanyRegistrationWarning companyIds={[id]} payPeriod="2026-11"/></NextIntlClientProvider>;
it('shows the exact selected employee count and a direct company-filter link',async()=>{check.mockResolvedValue({employees:7,companies:2,href:'/admin/organization?statutory=missing'});render(view('a'));expect(await screen.findByRole('status')).toHaveTextContent('7 employees');expect(screen.getByRole('link',{name:'Review companies'})).toHaveAttribute('href','/admin/organization?statutory=missing');});
it('discards the previous company response after selection changes',async()=>{let first!:(x:unknown)=>void;check.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValueOnce({employees:2,companies:1,href:'/admin/organization?statutory=missing'});const result=render(view('a'));result.rerender(view('b'));expect(await screen.findByRole('status')).toHaveTextContent('2 employees');first({employees:99,companies:1,href:'/wrong'});await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('2 employees'));expect(screen.queryByText(/99 employees/)).toBeNull();});
it('reports failed readiness instead of falsely claiming no issues',async()=>{check.mockRejectedValue(new Error('private database detail'));render(view('a'));expect(await screen.findByRole('alert')).toHaveTextContent('could not be checked');expect(screen.queryByText(/private database/)).toBeNull();});
it('omits a levy warning when the verified selected population is zero',async()=>{check.mockResolvedValue({employees:0,companies:0,href:'/admin/organization?statutory=missing'});render(view('a'));await waitFor(()=>expect(check).toHaveBeenCalledOnce());expect(screen.queryByRole('status')).toBeNull();});

it('renders the company statuses and payroll warning in the actual Atelier CSS',async()=>{
 check.mockResolvedValue({employees:7,companies:2,href:'/admin/organization?statutory=missing'});
 const result=render(<>{view('a')}<CompanyRegistrationPreview/></>);
 expect(await screen.findByRole('status')).toHaveTextContent('7 employees');
 expect(screen.getByRole('link',{name:'Complete'})).toHaveAttribute('href','/admin/organization/demo-a?tab=statutory');
 await captureAiReviewScreenshots(result.container.innerHTML,'en','company-registration','Actual company row and payroll warning components; fictional scoped inputs','atelier');
},60_000);
