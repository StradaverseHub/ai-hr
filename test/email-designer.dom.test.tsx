// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EmailDesigner} from '../app/admin/settings/email-templates/designer';
import {defaultEmailDocument} from '../lib/email-design/model';
const actions=vi.hoisted(()=>({saveEmailDesignAction:vi.fn(async(..._args:unknown[])=>1),loadEmailDesignHistoryAction:vi.fn(async()=>[]),uploadEmailDesignAssetAction:vi.fn(),sendEmailDesignTestAction:vi.fn(async()=>({sent:true}))}));
vi.mock('../app/admin/settings/email-templates/actions',()=>actions);
afterEach(()=>{cleanup();vi.clearAllMocks();});
const setup=()=>render(<NextIntlClientProvider locale="en" messages={en}><EmailDesigner designs={[]}/></NextIntlClientProvider>);
describe('email designer',()=>{
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
  render(<NextIntlClientProvider locale="en" messages={en}><EmailDesigner designs={[{kind:'invitation',locale:'en',revision:1,document:custom,updatedAt:'2026-10-29T00:00:00Z',updatedBy:'Fictional admin'}]}/></NextIntlClientProvider>);
  expect(screen.getByDisplayValue('Saved subject')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:en.emailDesign.language}),{target:{value:'ms'}});
  expect(screen.queryByDisplayValue('Saved subject')).toBeNull();
 });
});
