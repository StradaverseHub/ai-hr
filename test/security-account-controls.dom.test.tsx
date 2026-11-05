import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const ports=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../app/admin/users/[userId]/account/actions',()=>({accountAction:ports.action}));
import {AccountControls} from '../app/admin/users/[userId]/account/account-controls';
const locales={en,ms,zh,vi:viMessages,th,ta};
function show(locale:keyof typeof locales='en'){
 const messages=locales[locale];
 return render(<NextIntlClientProvider locale={locale} messages={messages}><main><h1 className="mb-6 text-2xl font-semibold">{messages.accountManagement.title} · Fictional Employee A</h1><AccountControls userId="fictional-target"/></main></NextIntlClientProvider>);
}
const panel=(type:string)=>screen.getByRole('button',{name:type}).closest('form')!;
beforeEach(()=>{vi.clearAllMocks();ports.action.mockResolvedValue({status:'saved'});});afterEach(cleanup);
describe('real account controls',()=>{
 it('binds six confirmed actions to one target with bounded recovery and temporary-password expiry',()=>{
  show();expect(document.querySelectorAll('form')).toHaveLength(6);
  for(const form of document.querySelectorAll('form')){
   expect(form.querySelector('input[name="userId"]')).toHaveValue('fictional-target');
   expect(within(form).getByRole('checkbox')).toBeRequired();expect(within(form).getByRole('checkbox')).not.toBeChecked();
   expect(form.querySelector('textarea[name="reason"]')).toBeRequired();
  }
  expect(panel(en.accountManagement['recovery-exemption']).querySelector('input[name="minutes"]')).toHaveAttribute('max','60');
  expect(panel(en.accountManagement['temporary-password']).querySelector('input[name="minutes"]')).toHaveAttribute('max','1440');
  expect(panel(en.accountManagement['temporary-password']).querySelector('input[name="confirmPassword"]')).toHaveAttribute('type','password');
  expect(screen.getByText(en.accountManagement.exemptionHelp)).toBeVisible();
 });
 it('submits a real form, shows a password once and keeps a dismissed password hidden after a failed retry',async()=>{
  ports.action.mockResolvedValueOnce({status:'saved',password:'Fictional temporary secret 936!'}).mockResolvedValueOnce({status:'failed'});
  show();const form=panel(en.accountManagement['temporary-password']);
  fireEvent.change(form.querySelector('textarea')!,{target:{value:'Fictional verified recovery'}});fireEvent.click(within(form).getByRole('checkbox'));
  await act(async()=>{fireEvent.submit(form);});
  expect(await screen.findByText('Fictional temporary secret 936!')).toBeVisible();expect(ports.action.mock.calls[0][1].get('type')).toBe('temporary-password');
  fireEvent.click(screen.getByRole('button',{name:en.accountManagement.hide}));expect(screen.queryByText('Fictional temporary secret 936!')).toBeNull();
  await act(async()=>{fireEvent.submit(form);});expect(await screen.findByRole('alert')).toHaveTextContent(en.accountManagement.failed);
  expect(screen.queryByText('Fictional temporary secret 936!')).toBeNull();
 });
 it('disables only the submitted control while pending and presents an honest failed email result',async()=>{
  let release!:(value:unknown)=>void;ports.action.mockReturnValue(new Promise(resolve=>{release=resolve;}));
  show();const form=panel(en.accountManagement['reset-email']);
  await act(async()=>{fireEvent.submit(form);});await waitFor(()=>expect(within(form).getByRole('button')).toBeDisabled());
  expect(within(panel(en.accountManagement.suspend)).getByRole('button')).not.toBeDisabled();
  await act(async()=>{release({status:'saved',delivery:'failed'});});
  expect(await screen.findByRole('alert')).toHaveTextContent(en.accountManagement.delivery.failed);
 });
 it.each(Object.keys(locales) as (keyof typeof locales)[])('renders %s controls for desktop and phone review using fictional account context',async locale=>{
  const view=show(locale);expect(view.container.querySelectorAll('form')).toHaveLength(6);
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'security-flyout-account-controls','real AccountControls component; fictional target and synthetic server-action port; no authenticated server journey');
 },60000);
});
