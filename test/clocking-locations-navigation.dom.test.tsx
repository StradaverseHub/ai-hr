import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/work-locations/clocking/new',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe.each(['classic','monolith','atelier'])('%s clocking locations navigation',theme=>{
 it('offers Settings without the duplicate Locations flyout entry',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin enabledModules={null} defaultCollapsed={false}/></NextIntlClientProvider>);
  const attendance=screen.getByRole('button',{name:messages.nav.moduleAttendance});
  if(attendance.getAttribute('aria-expanded')!=='true')fireEvent.click(attendance);
  const panel=screen.getByRole('navigation',{name:messages.nav.moduleAttendance});
  expect(within(panel).getByRole('link',{name:messages.nav.attendanceSettingsPage})).toHaveAttribute('href','/admin/attendance/settings');
  expect([...panel.querySelectorAll('a')].filter(a=>a.getAttribute('href')?.startsWith('/admin/work-locations'))).toHaveLength(0);
 });
});
