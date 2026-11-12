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
const ports=vi.hoisted(()=>({action:vi.fn(),generate:vi.fn(),history:vi.fn()}));
vi.mock('../app/admin/users/[userId]/account/actions',()=>({accountAction:ports.action,generatePasswordAction:ports.generate,accountHistoryAction:ports.history}));
import {AccountControls} from '../app/admin/users/[userId]/account/account-controls';
import {AuthenticatorControlDialog,ResetPasswordDialog} from '../app/admin/users/[userId]/account/account-dialogs';
const locales={en,ms,zh,vi:viMessages,th,ta};
const reset=en.accountManagement.resetPassword,auth=en.accountManagement.authenticator;
function show(locale:keyof typeof locales='en'){
 const messages=locales[locale];
 return render(<NextIntlClientProvider locale={locale} messages={messages}><main><h1 className="mb-6 text-2xl font-semibold">{messages.accountManagement.title} · Fictional Employee A</h1><AccountControls userId="fictional-target"/></main></NextIntlClientProvider>);
}
function dialogs(exemptionUntil:number|null=null,locale:keyof typeof locales='en'){
 return render(<NextIntlClientProvider locale={locale} messages={locales[locale]}><ResetPasswordDialog userId="fictional-target" name="Fictional Employee A" username="fictional.a" triggerClassName="underline"/><AuthenticatorControlDialog userId="fictional-target" name="Fictional Employee A" exemptionUntil={exemptionUntil} triggerClassName="underline"/></NextIntlClientProvider>);
}
const panel=(type:string)=>screen.getByRole('button',{name:type}).closest('form')!;
const lastForm=()=>ports.action.mock.calls.at(-1)![1] as FormData;
beforeEach(()=>{vi.clearAllMocks();ports.action.mockResolvedValue({status:'saved'});ports.history.mockResolvedValue({status:'ok',entries:[]});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('real account controls',()=>{
 it('keeps the four Edit controls bound to one target with reason and confirmation',()=>{
  show();expect(document.querySelectorAll('form')).toHaveLength(4);
  for(const form of document.querySelectorAll('form')){
   expect(form.querySelector('input[name="userId"]')).toHaveValue('fictional-target');
   expect(within(form).getByRole('checkbox')).toBeRequired();expect(within(form).getByRole('checkbox')).not.toBeChecked();
   expect(form.querySelector('textarea[name="reason"]')).toBeRequired();
  }
  expect(screen.queryByRole('button',{name:en.accountManagement['temporary-password']})).toBeNull();
  expect(screen.queryByRole('button',{name:en.accountManagement['recovery-exemption']})).toBeNull();
 });
 it('offers only the allowed Edit controls for the account status',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><AccountControls userId="fictional-target" allowed={['reactivate','expiry']}/></NextIntlClientProvider>);
  expect(document.querySelectorAll('form')).toHaveLength(2);expect(screen.queryByRole('button',{name:en.accountManagement.suspend})).toBeNull();
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
  const view=show(locale);expect(view.container.querySelectorAll('form')).toHaveLength(4);
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'security-flyout-account-controls','real AccountControls component; fictional target and synthetic server-action port; no authenticated server journey');
 },60000);
});
describe('Reset Password dialog',()=>{
 it('shows the read-only person, generates from the saved policy, copies and submits a 24-hour temporary password',async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
  ports.generate.mockResolvedValue({status:'ok',password:'Fictional policy password 801!'});
  dialogs();fireEvent.click(screen.getByRole('button',{name:reset.open}));
  const dialog=await screen.findByRole('dialog',{name:reset.title});
  expect(within(dialog).getByDisplayValue('Fictional Employee A')).toHaveAttribute('readonly');expect(within(dialog).getByDisplayValue('fictional.a')).toHaveAttribute('readonly');
  expect(dialog.querySelector('select[name="hours"]')!).toHaveValue('24');
  expect(within(dialog).getByRole('button',{name:reset.copy})).toBeDisabled();
  await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:reset.generate}));});
  expect(ports.generate).toHaveBeenCalledExactlyOnceWith('fictional-target');
  expect(dialog.querySelector('input[name="password"]')!).toHaveValue('Fictional policy password 801!');
  expect(dialog.querySelector('input[name="confirmPassword"]')!).toHaveValue('Fictional policy password 801!');
  await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:reset.copy}));});
  expect(writeText).toHaveBeenCalledExactlyOnceWith('Fictional policy password 801!');
  expect(within(dialog).getByRole('button',{name:reset.copied})).toBeTruthy();expect(within(dialog).getByRole('status')).toHaveTextContent(reset.copiedStatus);
  await act(async()=>{fireEvent.submit(within(dialog).getByRole('button',{name:reset.submit}).closest('form')!);});
  await waitFor(()=>expect(ports.action).toHaveBeenCalledTimes(1));
  const sent=lastForm();
  expect(Object.fromEntries(sent)).toEqual({type:'temporary-password',userId:'fictional-target',confirmed:'on',password:'Fictional policy password 801!',confirmPassword:'Fictional policy password 801!',hours:'24',reason:''});
  expect(await within(dialog).findByText(reset.saved)).toBeVisible();
 });
 it('refuses a confirmation mismatch before any server call and reports a failed generation',async()=>{
  ports.generate.mockResolvedValue({status:'failed'});
  dialogs();fireEvent.click(screen.getByRole('button',{name:reset.open}));
  const dialog=await screen.findByRole('dialog',{name:reset.title});
  await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:reset.generate}));});
  expect(within(dialog).getByRole('alert')).toHaveTextContent(reset.generateFailed);
  fireEvent.change(dialog.querySelector('input[name="password"]')!,{target:{value:'Fictional typed password 802!'}});
  fireEvent.change(dialog.querySelector('input[name="confirmPassword"]')!,{target:{value:'Fictional typed password 803!'}});
  fireEvent.change(dialog.querySelector('select[name="hours"]')!,{target:{value:'4'}});
  await act(async()=>{fireEvent.submit(within(dialog).getByRole('button',{name:reset.submit}).closest('form')!);});
  expect(within(dialog).getByRole('alert')).toHaveTextContent(reset.mismatch);expect(ports.action).not.toHaveBeenCalled();
  fireEvent.change(dialog.querySelector('input[name="confirmPassword"]')!,{target:{value:'Fictional typed password 802!'}});
  ports.action.mockResolvedValue({status:'failed'});
  await act(async()=>{fireEvent.submit(within(dialog).getByRole('button',{name:reset.submit}).closest('form')!);});
  await waitFor(()=>expect(ports.action).toHaveBeenCalledTimes(1));expect(lastForm().get('hours')).toBe('4');
  expect(await within(dialog).findByText(reset.failed)).toBeVisible();
 });
});
describe('Authenticator Control dialog',()=>{
 it('pauses until a chosen Malaysia time no more than 7 days ahead, with a required reason',async()=>{
  vi.useFakeTimers({now:Date.UTC(2026,10,10,2,0),toFake:['Date']});
  ports.history.mockResolvedValue({status:'ok',entries:[{at:'2026-11-07T10:02:00.000Z',event:'app-user.logged-in',actor:'Fictional Employee A',until:null},{at:'2026-11-01T02:45:00.000Z',event:'app-user.account-temporary-password',actor:'Fictional Admin',until:'2026-11-02T02:45:00.000Z'}]});
  dialogs();fireEvent.click(screen.getByRole('button',{name:auth.open}));
  const dialog=await screen.findByRole('dialog',{name:'Authenticator Control · Fictional Employee A'});
  expect(within(dialog).getByRole('button',{name:auth.required})).toHaveAttribute('aria-pressed','true');
  expect(within(dialog).getByText(auth.statusRequired)).toBeTruthy();expect(within(dialog).queryByRole('button',{name:auth.switchOn})).toBeNull();
  expect(await within(dialog).findByText('07-Nov-2026 18:02')).toBeTruthy();expect(within(dialog).getByText('Signed in')).toBeTruthy();
  expect(within(dialog).getByText('Temporary password issued by Fictional Admin')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button',{name:auth.paused}));
  const until=dialog.querySelector('input[name="until"]')!;
  expect(until).toHaveAttribute('max','2026-11-17T10:00');expect(until).toHaveAttribute('min','2026-11-10T10:05');expect(until).toHaveValue('2026-11-11T10:00');
  expect(dialog.querySelector('textarea[name="reason"]')).toBeRequired();expect(dialog.querySelector('textarea[name="reason"]')).toHaveAttribute('minLength','5');
  expect(within(dialog).getByText(auth.help.replaceAll('{name}','Fictional Employee A'))).toBeTruthy();
  fireEvent.change(until,{target:{value:'2026-11-12T17:00'}});fireEvent.change(dialog.querySelector('textarea[name="reason"]')!,{target:{value:'Fictional lost phone'}});
  await act(async()=>{fireEvent.submit(within(dialog).getByRole('button',{name:auth.save}).closest('form')!);});
  await waitFor(()=>expect(ports.action).toHaveBeenCalledTimes(1));
  expect(Object.fromEntries(lastForm())).toEqual({type:'recovery-exemption',userId:'fictional-target',confirmed:'on',until:'2026-11-12T17:00',reason:'Fictional lost phone'});
  expect(await within(dialog).findByText(auth.saved)).toBeTruthy();
  expect(within(dialog).getByText('Paused until 12-Nov-2026 17:00 · not yet used')).toBeTruthy();
 });
 it('shows an active pause and switches the check back on without a reason',async()=>{
  vi.useFakeTimers({now:Date.UTC(2026,10,10,2,0),toFake:['Date']});
  dialogs(Date.UTC(2026,10,12,9,0));fireEvent.click(screen.getByRole('button',{name:auth.open}));
  const dialog=await screen.findByRole('dialog',{name:'Authenticator Control · Fictional Employee A'});
  expect(within(dialog).getByRole('button',{name:auth.paused})).toHaveAttribute('aria-pressed','true');
  expect(within(dialog).getByText('Paused until 12-Nov-2026 17:00 · not yet used')).toBeTruthy();
  expect(dialog.querySelector('input[name="until"]')).toHaveValue('2026-11-12T17:00');
  await act(async()=>{fireEvent.submit(within(dialog).getByRole('button',{name:auth.switchOn}).closest('form')!);});
  await waitFor(()=>expect(ports.action).toHaveBeenCalledTimes(1));
  expect(Object.fromEntries(lastForm())).toEqual({type:'recovery-exemption-cancel',userId:'fictional-target',confirmed:'on'});
  expect(await within(dialog).findByText(auth.resumed)).toBeTruthy();expect(within(dialog).getByText(auth.statusRequired)).toBeTruthy();
 });
 it('treats an ended pause as required',async()=>{
  vi.useFakeTimers({now:Date.UTC(2026,10,10,2,0),toFake:['Date']});
  dialogs(Date.UTC(2026,10,10,1,0));fireEvent.click(screen.getByRole('button',{name:auth.open}));
  const dialog=await screen.findByRole('dialog',{name:'Authenticator Control · Fictional Employee A'});
  expect(within(dialog).getByRole('button',{name:auth.required})).toHaveAttribute('aria-pressed','true');expect(within(dialog).queryByRole('button',{name:auth.switchOn})).toBeNull();
 });
 it.each(Object.keys(locales) as (keyof typeof locales)[])('renders the %s dialogs for desktop and phone review',async locale=>{
  // A fixed clock: the pause below must still be running when the dialog opens, whatever today's date is.
  vi.useFakeTimers({now:Date.UTC(2026,10,10,2,0),toFake:['Date']});
  dialogs(Date.UTC(2026,10,12,9,0),locale);
  fireEvent.click(screen.getByRole('button',{name:locales[locale].accountManagement.authenticator.open}));
  const dialog=await screen.findByRole('dialog');expect(dialog.querySelector('input[name="until"]')).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(dialog),locale,'security-flyout-authenticator-control','real AuthenticatorControlDialog; fictional employee and synthetic server-action ports; no authenticated server journey');
 },60000);
});
