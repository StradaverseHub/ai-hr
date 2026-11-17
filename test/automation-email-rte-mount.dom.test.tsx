import {beforeAll,describe,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EmailEditor} from '../app/automation/templates/email-editor';
import {EmailBodyEditor} from '../components/email-body-editor';
import type {EmailBodyDoc} from '../lib/email-body/doc';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({searchPeopleAction:vi.fn(),sendTestEmailAction:vi.fn(),saveEmailTemplateAction:vi.fn()}));
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});});
describe('Native shared rich email editor mount',()=>{
 it('does not report content changes when mounting or changing only editability',async()=>{
  const change=vi.fn(),value:EmailBodyDoc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Fictional existing words'}]}]};
  const view=render(<EmailBodyEditor value={value} onChange={change} fields={[]} disabled={false}/>);
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable','true'));expect(change).not.toHaveBeenCalled();
  view.rerender(<EmailBodyEditor value={value} onChange={change} fields={[]} disabled/>);await waitFor(()=>expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable','false'));expect(change).not.toHaveBeenCalled();
  view.rerender(<EmailBodyEditor value={value} onChange={change} fields={[]} disabled={false}/>);await waitFor(()=>expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable','true'));expect(change).not.toHaveBeenCalled();
 });
 it('allows an unchanged saved template to test itself, and requires saving after a real edit',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><EmailEditor initial={{template:{id:'11111111-1111-4111-8111-111111111111',module:'contract_staff',name:'Fictional saved email',active:true,subject:'Contract update',body:'Dear {{employee.name}}',cc:[]},revision:1,retired:false}} refs={{routings:[],groups:[],people:[]}} onClose={vi.fn()}/></NextIntlClientProvider>);
  await screen.findByRole('textbox',{name:'Message'});fireEvent.click(screen.getByRole('tab',{name:'Preview'}));expect(screen.getByRole('button',{name:'Send test to me'})).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox',{name:'Template name'}),{target:{value:'Changed saved email'}});expect(screen.getByRole('button',{name:'Send test to me'})).toBeDisabled();expect(screen.getByText('Save changes before sending a test.')).toBeVisible();
 });
});
