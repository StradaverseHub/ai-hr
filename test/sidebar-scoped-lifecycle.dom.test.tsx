import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';
vi.mock('next/navigation',()=>({usePathname:()=> '/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
afterEach(cleanup);
it('admits the server-authorized company-scoped module without an HR role or a global Lifecycle purchase',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} probationAccess={{page:true,configure:false}} contractStaffAccess={{page:true,configure:false}} enabledModules={[]} defaultCollapsed={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:messages.nav.probationConfirmation}));
 expect(screen.getByRole('link',{name:messages.nav.probationTracker})).toHaveAttribute('href','/lifecycle/probation');
 fireEvent.click(screen.getByRole('button',{name:messages.nav.contractManagement}));
 expect(screen.getByRole('link',{name:messages.nav.contractManagement})).toHaveAttribute('href','/lifecycle/contracts');expect(screen.queryByRole('link',{name:messages.nav.probationSettings})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.contractSettings})).not.toBeInTheDocument();
});
it('keeps new operational and preparation destinations hidden when their owner admits neither',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={true} enabledModules={['lifecycle']} defaultCollapsed={false}/></NextIntlClientProvider>);
 expect(screen.queryByRole('link',{name:messages.nav.probationTracker})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.contractManagement})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.probationSettings})).not.toBeInTheDocument();
});
it('shows scoped intake preparation without enabling runtime cases or unrelated configuration',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} probationAccess={{page:false,configure:false,intake:true}} enabledModules={[]} defaultCollapsed={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:messages.nav.probationConfirmation}));
 expect(screen.getByRole('link',{name:messages.nav.probationIntake})).toHaveAttribute('href','/lifecycle/probation/intake');expect(screen.queryByRole('link',{name:messages.nav.probationTracker})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.probationSettings})).not.toBeInTheDocument();
});
it('does not advertise Contract intake through configuration authority alone',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} contractStaffAccess={{page:false,configure:true,intake:false}} enabledModules={[]} defaultCollapsed={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:messages.nav.contractManagement}));
 expect(screen.getByRole('link',{name:messages.nav.contractSettings})).toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.contractIntake})).not.toBeInTheDocument();
});
it('offers the shared HR Automation builders to a Probation configurer, and Personnel postings beside the tracker',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} probationAccess={{page:true,configure:true}} enabledModules={[]} defaultCollapsed={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:messages.nav.probationConfirmation}));
 expect(screen.getByRole('link',{name:messages.nav.probationPostings})).toHaveAttribute('href','/lifecycle/probation/postings');
 expect(screen.getByRole('link',{name:messages.nav.probationSettings})).toHaveAttribute('href','/lifecycle/probation/settings');
 expect(screen.queryByRole('link',{name:messages.nav.probationWorkflows})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:messages.nav.probationTemplates})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:messages.nav.moduleHrAutomation}));
 expect(screen.getByRole('link',{name:messages.nav.automationWorkflows})).toHaveAttribute('href','/automation/workflows');
 expect(screen.getByRole('link',{name:messages.nav.automationTemplates})).toHaveAttribute('href','/automation/templates');
 expect(screen.getByRole('link',{name:messages.nav.automationGroups})).toHaveAttribute('href','/automation/groups');
 expect(screen.queryByRole('link',{name:messages.nav.automationOnOffWorkflows})).not.toBeInTheDocument();
});
it('keeps the shared builders hidden from someone who configures no module',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={true} probationAccess={{page:true,configure:false,intake:true}} enabledModules={['lifecycle']} defaultCollapsed={false}/></NextIntlClientProvider>);
 expect(screen.queryByRole('button',{name:messages.nav.moduleHrAutomation})).not.toBeInTheDocument();
 expect(screen.queryByRole('link',{name:messages.nav.automationWorkflows})).not.toBeInTheDocument();
});
