import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viWords from '../messages/vi.json';
import {HomePersonPrivacyEditor} from '../components/employee-home/person-privacy-editor';
import {parseHomePersonPrivacyForm} from '../lib/employee-home-person-privacy';
const state=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('../app/(app)/me/home/privacy-actions',()=>({saveHomePersonPrivacyAction:state.save}));
vi.mock('next/navigation',()=>({unstable_rethrow:()=>{}}));
const catalogues={en,ms,zh,ta,th,vi:viWords};
beforeEach(()=>{vi.clearAllMocks();state.save.mockReset();state.save.mockResolvedValue({error:'invalid'});});afterEach(cleanup);
function mount(locale:keyof typeof catalogues='en',saved=false){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><HomePersonPrivacyEditor initial={{version:1,ordinal:3,hideBirthday:true,hideAnniversary:false}} saved={saved}/></NextIntlClientProvider>);
}
const form=()=>screen.getByRole('button',{name:en.employeeHome.personPrivacy.save}).closest('form')!;
describe('Person-wide celebration privacy editor',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels separate explicit choices without writing on mount',locale=>{
  mount(locale);const words=catalogues[locale].employeeHome.personPrivacy;
  expect(screen.getByRole('checkbox',{name:words.hideBirthday})).toBeChecked();expect(screen.getByRole('checkbox',{name:words.hideAnniversary})).not.toBeChecked();
  expect(screen.getByRole('group',{name:words.title})).toHaveAccessibleDescription(words.policyHelp);
  expect(screen.getByRole('button',{name:words.save})).toBeEnabled();expect(state.save).not.toHaveBeenCalled();
 });
 it('posts the explicit boxes and displayed version through the real parser and retains a refused draft',async()=>{
  mount();fireEvent.click(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday}));fireEvent.click(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideAnniversary}));
  fireEvent.submit(form());await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  expect(parseHomePersonPrivacyForm(state.save.mock.calls[0][1])).toEqual({expectedOrdinal:3,hideBirthday:false,hideAnniversary:true});
  const alert=await screen.findByRole('alert');await waitFor(()=>expect(alert).toHaveFocus());
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideAnniversary})).toBeChecked();
 });
 it('blocks repeat submissions while unresolved and requires reloading a stale saved version',async()=>{
  let finish!:(value:{error:'changed'})=>void;state.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));mount();
  const target=form();fireEvent.submit(target);fireEvent.submit(target);await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday})).toBeDisabled();finish({error:'changed'});
  expect(await screen.findByRole('alert')).toHaveTextContent(en.employeeHome.personPrivacy.changed);
  expect(screen.getByRole('link',{name:en.employeeHome.personPrivacy.reload})).toHaveAttribute('href','/me/home');
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday})).toBeChecked();
 });
 it('keeps the draft and excludes diagnostics after an uncertain save',async()=>{
  state.save.mockRejectedValue(Error('Private transport details'));mount();fireEvent.submit(form());
  const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(en.employeeHome.personPrivacy.failed);expect(alert).not.toHaveTextContent('Private transport details');
  expect(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday})).toBeChecked();
 });
 it('clears an earlier saved message on editing and never presents success beside a stale refusal',async()=>{
  state.save.mockResolvedValue({error:'changed'});mount('en',true);
  expect(screen.getByRole('status')).toHaveTextContent(en.employeeHome.personPrivacy.saved);
  fireEvent.click(screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday}));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();fireEvent.submit(form());
  expect(await screen.findByRole('alert')).toHaveTextContent(en.employeeHome.personPrivacy.changed);expect(screen.queryByRole('status')).not.toBeInTheDocument();
 });
 it('confirms an owner-verified unchanged choice and clears that confirmation on the next edit',async()=>{
  state.save.mockResolvedValue({error:null,alreadySaved:true});mount('en',true);
  const birthday=screen.getByRole('checkbox',{name:en.employeeHome.personPrivacy.hideBirthday});fireEvent.click(birthday);fireEvent.click(birthday);fireEvent.submit(form());
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(en.employeeHome.personPrivacy.alreadySaved));expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(birthday);expect(screen.queryByRole('status')).not.toBeInTheDocument();
 });
});
