import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vietnamese from '../messages/vi.json';
import {HomeConfigurationEditor} from '../components/employee-home/configuration-editor';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {parseEmployeeHomeConfigurationForm} from '../lib/employee-home-configuration-form';
const state=vi.hoisted(()=>({save:vi.fn(),push:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/(app)/admin/settings/dashboard/home-actions',()=>({saveHomeConfigurationAction:state.save}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:state.push,refresh:state.refresh})}));
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
const initial=()=>({version:1 as const,companyId:'e17dbd09-a9a1-448c-b609-fcd74566baf6',audienceRole:'employee' as const,revisionId:null,ordinal:0,configuration:defaultEmployeeHomeConfiguration()});
beforeEach(()=>{vi.clearAllMocks();state.save.mockResolvedValue({error:'Fictional refusal'});});
afterEach(cleanup);
function mount(locale:keyof typeof catalogues='en'){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><HomeConfigurationEditor initial={initial()}/></NextIntlClientProvider>);
}
const form=()=>screen.getByRole('button',{name:en.employeeHome.configuration.save}).closest('form')!;
describe('Home configuration editing',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels every editable section and all language fields',locale=>{
  const result=mount(locale),words=catalogues[locale].employeeHome.configuration;
  expect(screen.getByRole('button',{name:words.save})).toBeEnabled();
  expect(screen.getByText(words.quickTitle)).toBeVisible();expect(screen.getByText(words.templatesTitle)).toBeVisible();expect(screen.getByText(words.sharingTitle)).toBeVisible();
  expect(result.container.querySelectorAll('textarea[name^="template."]')).toHaveLength(13*6);
  expect(result.container.querySelector('form')).toHaveAttribute('method','post');
 });
 it('posts the actual rendered fields and quick-action order through the production parser',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'Move Apply leave down'}));
  fireEvent.change(screen.getByRole('textbox',{name:en.employeeHome.configuration.reason}),{target:{value:'Fictional reviewed copy change'}});
  fireEvent.submit(form());await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  const parsed=parseEmployeeHomeConfigurationForm(state.save.mock.calls[0][1]);
  expect(parsed.companyId).toBe(initial().companyId);expect(parsed.expectedOrdinal).toBe(0);
  expect(parsed.configuration.quickActions).toEqual(['claim','leave','payslip','profile']);
  expect(parsed.configuration.templates).toEqual(initial().configuration.templates);expect(parsed.configuration.effortMinutes).toEqual({});
 });
 it('keeps translations, reason and selects after refusal and sends one command despite repeated submits',async()=>{
  let finish!:(value:{error:string})=>void;state.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  mount();const english=screen.getAllByLabelText('English')[0] as HTMLTextAreaElement;
  fireEvent.change(english,{target:{value:'Fictional reviewed morning for {name}.'}});
  fireEvent.change(screen.getByRole('combobox',{name:en.employeeHome.configuration.teamVisibility}),{target:{value:'department'}});
  const reason=screen.getByRole('textbox',{name:en.employeeHome.configuration.reason});fireEvent.change(reason,{target:{value:'Fictional retained draft'}});
  const target=form();fireEvent.submit(target);fireEvent.submit(target);
  await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  finish({error:'Fictional stale version'});
  const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent('Fictional stale version');await waitFor(()=>expect(alert).toHaveFocus());
  expect(english.value).toBe('Fictional reviewed morning for {name}.');expect(reason).toHaveValue('Fictional retained draft');
  expect(screen.getByRole('combobox',{name:en.employeeHome.configuration.teamVisibility})).toHaveValue('department');
  expect(state.push).not.toHaveBeenCalled();
 });
 it('keeps an uncertain transport save honest and preserves the draft for readback',async()=>{
  state.save.mockRejectedValueOnce(new TypeError('Private transport error'));mount();
  const reason=screen.getByRole('textbox',{name:en.employeeHome.configuration.reason});fireEvent.change(reason,{target:{value:'Fictional retained on network error'}});
  fireEvent.submit(form());const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(en.employeeHome.configuration.failed);expect(alert).not.toHaveTextContent('Private transport');expect(reason).toHaveValue('Fictional retained on network error');
 });
 it('navigates only after a confirmed save and blocks another save while navigation finishes',async()=>{
  const destination='/admin/settings/dashboard?section=content&toast=Saved';state.save.mockResolvedValueOnce({error:null,destination});mount();
  const target=form();fireEvent.submit(target);await waitFor(()=>expect(state.push).toHaveBeenCalledWith(destination));expect(state.refresh).toHaveBeenCalledOnce();
  fireEvent.submit(target);expect(state.save).toHaveBeenCalledOnce();
 });
 it('opens the containing message when native validation finds a hidden field',()=>{
  mount();const english=screen.getAllByLabelText('English')[0] as HTMLTextAreaElement,details=english.closest('details')!;
  expect(details.open).toBe(false);fireEvent.invalid(english);expect(details.open).toBe(true);
 });
});
