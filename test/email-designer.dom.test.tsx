// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {EmailDesigner} from '../app/admin/settings/email-templates/designer';
import {sampleEmailSystem} from '../lib/email-design/catalogue';
import {emailKinds,emailLocale,type EmailKind,type EmailLocale,type EmailDocument,defaultEmailDocument} from '../lib/email-design/model';
const actions=vi.hoisted(()=>({saveEmailDesignAction:vi.fn(async(..._args:unknown[])=>1),loadEmailDesignHistoryAction:vi.fn(async():Promise<{revision:number;document:EmailDocument|null;createdAt:string;createdBy:string|null}[]>=>[]),uploadEmailDesignAssetAction:vi.fn(),sendEmailDesignTestAction:vi.fn(async()=>({sent:true}))}));
vi.mock('../app/admin/settings/email-templates/actions',()=>actions);
afterEach(()=>{cleanup();vi.clearAllMocks();actions.loadEmailDesignHistoryAction.mockResolvedValue([]);});
const sampleSystems=Object.fromEntries(emailKinds.map(kind=>[kind,Object.fromEntries(emailLocale.options.map(locale=>[locale,sampleEmailSystem(kind,locale)]))])) as Record<EmailKind,Record<EmailLocale,ReturnType<typeof sampleEmailSystem>>>;
const setup=()=>render(<NextIntlClientProvider locale="en" messages={en}><EmailDesigner canEdit designs={[]} sampleSystems={sampleSystems}/></NextIntlClientProvider>);
describe('email designer',()=>{
 it.each(Object.entries({en,ms,zh,ta,th,vi:viMessages}))('keeps preview, language and history available with mutation controls closed in %s',async(locale,messages)=>{
  actions.loadEmailDesignHistoryAction.mockResolvedValue([{revision:1,document:null,createdAt:'2026-10-29T00:00:00Z',createdBy:'Fictional admin'}]);
  render(<NextIntlClientProvider locale={locale} messages={messages}><EmailDesigner designs={[]} sampleSystems={sampleSystems}/></NextIntlClientProvider>);
  const t=messages.emailDesign;
  for(const name of [t.save,t.sendTest,t.restoreDefault,t.blocksNames.text])expect(screen.getByRole('button',{name}).matches(':disabled')).toBe(true);
  const subject=screen.getByRole<HTMLInputElement>('textbox',{name:t.subject});expect(subject.matches(':disabled')).toBe(true);
  const before=subject.value;fireEvent.change(subject,{target:{value:'Forged local edit'}});expect(subject.value).toBe(before);
  expect(screen.getByRole('combobox',{name:t.language}).matches(':disabled')).toBe(false);
  expect(document.querySelector('iframe')!.srcdoc).toContain('SAMPLE');
  fireEvent.click(screen.getByRole('button',{name:t.history}));expect((await screen.findByRole('button',{name:t.restoreVersion})).matches(':disabled')).toBe(true);
  expect(actions.saveEmailDesignAction).not.toHaveBeenCalled();expect(actions.sendEmailDesignTestAction).not.toHaveBeenCalled();
 });
 it('protects the AIHR block, shows the available details and previews in a sandbox',()=>{
  setup();fireEvent.click(screen.getByRole('button',{name:'2. AIHR block'}));expect(screen.getByText(en.emailDesign.protectedHelp)).toBeTruthy();
  expect(document.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
  expect(document.querySelector('iframe')!.srcdoc).toContain('SAMPLE');
  expect(screen.getByText('{first_name} · {company_name} · {organization_code} · {expiry_days}')).toBeTruthy();
 });
 it('can add text, edit content, reorder and save the same document used for preview',async()=>{
  setup();fireEvent.click(screen.getByRole('button',{name:en.emailDesign.blocksNames.text}));
  fireEvent.change(screen.getByRole('textbox',{name:en.emailDesign.heading}),{target:{value:'Welcome {first_name}'}});
  expect(document.querySelector('iframe')!.srcdoc).toContain('Welcome Alex');
  fireEvent.click(screen.getByRole('button',{name:en.emailDesign.save}));
  await waitFor(()=>expect(actions.saveEmailDesignAction).toHaveBeenCalled());
  expect(actions.saveEmailDesignAction.mock.calls[0][0]).toBe('invitation');
 });
 it('changes language without copying customized wording into unedited languages',()=>{
  const custom={...defaultEmailDocument('invitation'),subject:'Saved subject'};
  render(<NextIntlClientProvider locale="en" messages={en}><EmailDesigner canEdit designs={[{kind:'invitation',locale:'en',revision:1,document:custom,updatedAt:'2026-10-29T00:00:00Z',updatedBy:'Fictional admin'}]} sampleSystems={sampleSystems}/></NextIntlClientProvider>);
  expect(screen.getByDisplayValue('Saved subject')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:en.emailDesign.language}),{target:{value:'ms'}});
  expect(screen.queryByDisplayValue('Saved subject')).toBeNull();
 });
 it('restores a historical system-default version as the default marker, not a custom copy',async()=>{
  actions.loadEmailDesignHistoryAction.mockResolvedValue([{revision:1,document:null,createdAt:'2026-10-29T00:00:00Z',createdBy:'Fictional admin'}]);
  setup();fireEvent.click(screen.getByRole('button',{name:en.emailDesign.history}));
  fireEvent.click(await screen.findByRole('button',{name:en.emailDesign.restoreVersion}));
  await waitFor(()=>expect(screen.getByRole<HTMLButtonElement>('button',{name:en.emailDesign.save}).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:en.emailDesign.save}));
  await waitFor(()=>expect(actions.saveEmailDesignAction).toHaveBeenCalled());expect(actions.saveEmailDesignAction.mock.calls[0][2]).toBeNull();
 });

});
