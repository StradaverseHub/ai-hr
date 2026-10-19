import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=> '/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';

afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe.each(['classic','monolith','current'])('%s Profile Changes navigation',theme=>{
 it.each([
  {viewer:'HR administrator',rail:true,review:true,manager:false},
  {viewer:'payroll partner',rail:true,review:false,manager:false},
  {viewer:'performance partner',rail:true,review:false,manager:false},
  {viewer:'manager',rail:false,review:false,manager:true},
  {viewer:'employee',rail:false,review:false,manager:false},
 ])('keeps the named queue separate from the broad administration rail for $viewer',({rail,review,manager})=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
   <Sidebar isAdmin={rail} canReviewProfileChanges={review} canApprove={manager} canAccessTeam={manager} enabledModules={null} defaultCollapsed={false}/>
  </NextIntlClientProvider>);
  const people=screen.queryByRole('button',{name:messages.nav.modulePeople,exact:true});
  if(people)fireEvent.click(people);
  if(review){
   const panel=screen.getByRole('navigation',{name:messages.nav.modulePeople});
   expect(within(panel).getByRole('link',{name:messages.nav.profileChanges,exact:true})).toHaveAttribute('href','/admin/personnel/profile-changes');
   expect(within(panel).getByText(messages.nav.sectionHR)).toBeInTheDocument();
  }else expect(screen.queryByRole('link',{name:messages.nav.profileChanges,exact:true})).toBeNull();
 });
});
