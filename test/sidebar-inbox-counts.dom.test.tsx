import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=> '/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';

const rail=(approvalCount:number,taskCount:number)=><NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
 <Sidebar isAdmin canApprove enabledModules={null} defaultCollapsed={false} approvalCount={approvalCount} taskCount={taskCount}/>
</NextIntlClientProvider>;
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});

describe.each(['classic','monolith','current'])('%s Inbox counts',theme=>{
 it('announces each queue independently and removes both badges at zero',()=>{
  document.documentElement.setAttribute('data-ui-theme',theme);
  const view=render(rail(3,8));
  fireEvent.click(screen.getByRole('button',{name:messages.nav.inbox}));
  let inbox=screen.getByRole('navigation',{name:messages.nav.inbox});
  expect(within(inbox).getByRole('link',{name:`${messages.nav.approvals}, 3 items awaiting your decision`})).toHaveAttribute('href','/approvals');
  expect(within(inbox).getByRole('link',{name:`${messages.nav.myTasks}, 8 items awaiting your decision`})).toHaveAttribute('href','/tasks');
  view.rerender(rail(0,0));
  inbox=screen.getByRole('navigation',{name:messages.nav.inbox});
  expect(within(inbox).getByRole('link',{name:messages.nav.approvals})).toHaveAttribute('href','/approvals');
  expect(within(inbox).getByRole('link',{name:messages.nav.myTasks})).toHaveAttribute('href','/tasks');
  expect(within(inbox).queryByText('3')).toBeNull();
  expect(within(inbox).queryByText('8')).toBeNull();
 });
});
