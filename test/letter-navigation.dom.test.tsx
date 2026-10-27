import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({usePathname:()=>'/',useSearchParams:()=>new URLSearchParams(),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {Sidebar} from '../components/sidebar';
const rail=(paths:string[])=><NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}><Sidebar isAdmin enabledModules={['employees']} defaultCollapsed={false} letterDestinations={paths}/></NextIntlClientProvider>;
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
it.each(['classic','monolith','atelier'])('shows only granted Letters destinations and removes revoked links in %s',theme=>{
 document.documentElement.setAttribute('data-ui-theme',theme);const view=render(rail(['/letters/approval','/letters/settings']));fireEvent.click(screen.getByRole('button',{name:messages.nav.modulePeople}));let people=screen.getByRole('navigation',{name:messages.nav.modulePeople});expect(within(people).getByRole('link',{name:messages.nav.letterApproval})).toHaveAttribute('href','/letters/approval');expect(within(people).getByRole('link',{name:messages.nav.letterSettings})).toHaveAttribute('href','/letters/settings');expect(within(people).queryByRole('link',{name:messages.nav.letterTemplates})).toBeNull();view.rerender(rail([]));people=screen.getByRole('navigation',{name:messages.nav.modulePeople});expect(within(people).queryByRole('link',{name:messages.nav.letterSettings})).toBeNull();expect(within(people).queryByRole('link',{name:messages.nav.letterApproval})).toBeNull();
});
