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
import {HomePreferencesEditor} from '../components/employee-home/preferences-editor';
import {defaultEmployeeHomePreferences,EMPLOYEE_HOME_CARD_DEFAULTS} from '../lib/employee-home';
import {parseHomePreferenceForm} from '../lib/employee-home-preferences-form';
const state=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('../app/(app)/me/home/actions',()=>({saveHomePreferencesAction:state.save}));
vi.mock('next/navigation',()=>({unstable_rethrow:()=>{}}));
const catalogues={en,ms,zh,ta,th,vi:viWords};
beforeEach(()=>{vi.clearAllMocks();state.save.mockReset();state.save.mockResolvedValue({error:'invalid'});});afterEach(cleanup);
function mount(locale:keyof typeof catalogues='en',cards=EMPLOYEE_HOME_CARD_DEFAULTS){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><HomePreferencesEditor initial={defaultEmployeeHomePreferences()} cards={cards}/></NextIntlClientProvider>);
}
const form=()=>screen.getByRole('button',{name:en.employeeHome.preferences.save}).closest('form')!;
describe('Home preference editing',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels every card and display choice',locale=>{
  mount(locale);const words=catalogues[locale].employeeHome.preferences;
  expect(screen.getByRole('combobox',{name:words.language})).toHaveValue(locale);
  expect(screen.getByRole('combobox',{name:words.weekStart})).toHaveValue('1');
  expect(screen.getByRole('textbox',{name:words.timeZone})).toHaveAccessibleDescription(words.timeZoneHelp);
  expect(screen.getAllByRole('checkbox')).toHaveLength(8);expect(screen.getByRole('checkbox',{name:catalogues[locale].employeeHome.cardNames.summary})).toBeDisabled();
  expect(screen.getByRole('button',{name:words.save})).toBeEnabled();
 });
 it('keeps focus on the moved row and posts the new order and visibility through the real parser',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'Move Your Day up'}));
  expect(screen.getByRole('button',{name:'Move Your Day down'})).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Your Day moved to position 1.');
  fireEvent.click(screen.getByRole('checkbox',{name:en.employeeHome.cardNames.team}));
  fireEvent.change(screen.getByRole('textbox',{name:en.employeeHome.preferences.timeZone}),{target:{value:'America/New_York'}});
  fireEvent.change(screen.getByRole('combobox',{name:en.employeeHome.preferences.weekStart}),{target:{value:'6'}});
  fireEvent.submit(form());await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  const parsed=parseHomePreferenceForm(state.save.mock.calls[0][1]);expect(parsed.command).toBe('save');
  if(parsed.command==='save'){expect(parsed.preferences.cardOrder.slice(0,2)).toEqual(['today','summary']);expect(parsed.preferences.hiddenCards).toEqual(['team']);expect(parsed.preferences).toMatchObject({timeZone:'America/New_York',weekStartsOn:6});}
  await screen.findByRole('alert');expect(screen.getByRole('textbox',{name:en.employeeHome.preferences.timeZone})).toHaveValue('America/New_York');
 });
 it('keeps a refused draft and prevents double submission while the action is unresolved',async()=>{
  let finish!:(value:{error:'forbidden'})=>void;state.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));mount();
  const zone=screen.getByRole('textbox',{name:en.employeeHome.preferences.timeZone});fireEvent.change(zone,{target:{value:'Asia/Tokyo'}});
  const target=form();fireEvent.submit(target);fireEvent.submit(target);await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());finish({error:'forbidden'});
  const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(en.employeeHome.preferences.forbidden);await waitFor(()=>expect(alert).toHaveFocus());expect(zone).toHaveValue('Asia/Tokyo');
 });
 it('requests a reset only after an explicit click, independently of unsaved invalid fields',async()=>{
  mount();fireEvent.change(screen.getByRole('textbox',{name:en.employeeHome.preferences.timeZone}),{target:{value:'invalid/timezone'}});
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.preferences.reset}));
  await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());expect(parseHomePreferenceForm(state.save.mock.calls[0][1])).toEqual({command:'reset'});
  await screen.findByRole('alert');
 });
 it('retains the draft after an uncertain transport failure',async()=>{
  state.save.mockRejectedValue(new Error('Private transport diagnostic'));mount();fireEvent.submit(form());
  const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(en.employeeHome.preferences.failed);expect(alert).not.toHaveTextContent('Private transport');
 });
});
