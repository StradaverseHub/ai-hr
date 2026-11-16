import {afterEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render as mount,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import type {ReactNode} from 'react';
import messages from '../messages/en.json';
import {AutomationEmailAssets,ContractEmailCaseFiles} from '../app/automation/templates/automation-email-assets';
import type {AutomationEmailTemplate} from '../lib/automation/email';
const refresh=vi.fn();vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
const render=(ui:ReactNode)=>mount(<NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={messages}>{ui}</NextIntlClientProvider>);
afterEach(()=>{vi.unstubAllGlobals();refresh.mockClear();});
const id='a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6',caseId='b1b2c3d4-1111-4111-8111-a1b2c3d4e5f6',slotId='c1b2c3d4-1111-4111-8111-a1b2c3d4e5f6';
const template:AutomationEmailTemplate={id,module:'contract_staff',name:'Fictional email',active:true,subject:'Information',body:'Body',cc:[]};
describe('Shared email file controls',()=>{
 it('requires a saved template revision before accepting uploads',()=>{
  render(<AutomationEmailAssets template={template} revision={0} ready={false} disabled={false} onChange={vi.fn()}/>);
  expect(screen.getByLabelText('Add image')).toBeDisabled();expect(screen.getByLabelText('Add a shared file')).toBeDisabled();expect(screen.getByText('Save the template before uploading files.')).toBeVisible();
 });
 it('binds a per-person upload to the actual case and slot, then refreshes only on success',async()=>{
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({asset:{id}})});vi.stubGlobal('fetch',fetch);
  render(<ContractEmailCaseFiles caseId={caseId} editable items={[{templateId:id,templateName:'Fictional email',revision:3,slots:[{id:slotId,label:'Voucher',required:true,file:null}]}]}/>);
  const file=new File(['Fictional voucher'],'voucher.txt',{type:'text/plain'});
  fireEvent.change(screen.getByLabelText(/Voucher/),{target:{files:[file]}});
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce());
  const data=fetch.mock.calls[0][1].body as FormData;
  expect(fetch.mock.calls[0][0]).toBe('/automation/templates/assets');
  expect([data.get('templateId'),data.get('module'),data.get('revision'),data.get('kind'),data.get('caseId'),data.get('slotId')]).toEqual([id,'contract_staff','3','file',caseId,slotId]);
 });
 it('holds a rejected upload and presents recovery without replacing the current file',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,json:async()=>({error:'The template changed. Reload before uploading.'})}));
  render(<ContractEmailCaseFiles caseId={caseId} editable items={[{templateId:id,templateName:'Fictional email',revision:3,slots:[{id:slotId,label:'Voucher',required:true,file:null}]}]}/>);
  fireEvent.change(screen.getByLabelText(/Voucher/),{target:{files:[new File(['Fictional voucher'],'voucher.txt',{type:'text/plain'})]}});
  expect(await screen.findByRole('alert')).toHaveTextContent('The template changed. Reload before uploading.');expect(refresh).not.toHaveBeenCalled();
 });
});
