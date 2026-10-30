import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=> '/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
afterEach(cleanup);
it.each([true,false])('uses actual V9 access rather than an HR role for the operational workspace link (%s)',allowed=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin={false} onboardingV9Access={allowed} onboardingV9Navigation={{onboarding:allowed,offboarding:false,administration:false}} enabledModules={['lifecycle']} defaultCollapsed={false}/></NextIntlClientProvider>);
 const module=screen.queryByRole('button',{name:messages.nav.moduleOnboarding});if(module)fireEvent.click(module);
 if(allowed)expect(screen.getByRole('link',{name:messages.nav.newJoiners})).toHaveAttribute('href','/lifecycle/v9');else expect(screen.queryByRole('link',{name:messages.nav.newJoiners})).not.toBeInTheDocument();
});
