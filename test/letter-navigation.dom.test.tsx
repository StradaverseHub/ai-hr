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
// 7baeb78e — Letters moved out of People into its own E-Letter module. The guard is reversed, not removed:
// granted letter destinations appear under E-Letter, revoked ones disappear, and People holds none of them.
const letterLinks=[messages.nav.letterApproval,messages.nav.letterSettings,messages.nav.letterTemplates,messages.nav.myLetters];
it.each(['classic','monolith','atelier'])('shows only granted Letters destinations under E-Letter, never under People, in %s',theme=>{
 document.documentElement.setAttribute('data-ui-theme',theme);const view=render(rail(['/letters/approval','/letters/settings']));
 fireEvent.click(screen.getByRole('button',{name:messages.nav.moduleELetter}));
 const letters=screen.getByRole('navigation',{name:messages.nav.moduleELetter});
 expect(within(letters).getByRole('link',{name:messages.nav.letterApproval})).toHaveAttribute('href','/letters/approval');
 expect(within(letters).getByRole('link',{name:messages.nav.letterSettings})).toHaveAttribute('href','/letters/settings');
 expect(within(letters).getByRole('link',{name:messages.nav.myLetters})).toHaveAttribute('href','/me/letters');
 expect(within(letters).queryByRole('link',{name:messages.nav.letterTemplates})).toBeNull();
 fireEvent.keyDown(document,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:messages.nav.modulePeople}));
 const people=screen.getByRole('navigation',{name:messages.nav.modulePeople});
 for(const name of letterLinks)expect(within(people).queryByRole('link',{name})).toBeNull();
 // Revoked: only the person's own letters remain, as a single E-Letter entry.
 fireEvent.keyDown(document,{key:'Escape'});view.rerender(rail([]));
 expect(screen.queryByRole('link',{name:messages.nav.letterApproval})).toBeNull();
 expect(screen.queryByRole('link',{name:messages.nav.letterSettings})).toBeNull();
 expect(screen.getByRole('link',{name:messages.nav.moduleELetter})).toHaveAttribute('href','/me/letters');
});
