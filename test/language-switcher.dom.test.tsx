import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const f=vi.hoisted(()=>({setLocale:vi.fn()}));
vi.mock('next-intl',()=>({useLocale:()=> 'en'}));
vi.mock('../app/i18n-actions',()=>({setLocale:f.setLocale}));
import {LanguageSwitcher} from '../components/language-switcher';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('does not submit the already active locale',async()=>{
 render(<LanguageSwitcher/>);await userEvent.click(screen.getByRole('button',{name:'Change language'}));
 const active=screen.getByRole('button',{name:'English'});expect(active).toBeDisabled();await userEvent.click(active);expect(f.setLocale).not.toHaveBeenCalled();
});
it('submits once, keeps the form mounted and blocks duplicate actions while the server is pending',async()=>{
 let finish!:()=>void;f.setLocale.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 render(<LanguageSwitcher/>);await userEvent.click(screen.getByRole('button',{name:'Change language'}));
 await userEvent.click(screen.getByRole('button',{name:'简体中文'}));
 await waitFor(()=>expect(f.setLocale).toHaveBeenCalledTimes(1));
 expect(f.setLocale.mock.calls[0][0].get('locale')).toBe('zh');
 const trigger=screen.getByRole('button',{name:'Change language'});expect(trigger).toBeDisabled();expect(trigger).toHaveAttribute('aria-busy','true');
 expect(document.querySelector('form')).toBeInTheDocument();
 await userEvent.click(trigger);expect(f.setLocale).toHaveBeenCalledTimes(1);
 await act(async()=>{finish();});await waitFor(()=>expect(trigger).not.toBeDisabled());
});
