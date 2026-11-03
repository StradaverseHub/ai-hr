import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {SignerControls} from '../app/lifecycle/probation/signer-controls';
import type {SigningDocument,SigningRoute} from '../lib/document-signing-model';
const m=vi.hoisted(()=>({replace:vi.fn(),override:vi.fn(),refresh:vi.fn(),dirty:vi.fn()}));
vi.mock('../app/lifecycle/probation/actions',()=>({replaceSigner:m.replace,overrideRoute:m.override}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh})}));
const route:SigningRoute={version:1,steps:[{id:'lm',role:'lm',kind:'sign',stage:0,holderId:'manager',holderPersonId:'manager-person',required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:1,holderId:'staff',required:true},{id:'hod',role:'hod',kind:'approve',stage:2,holderId:'head',required:true}]};
function show(signing?:SigningDocument,canOverride=false){return render(<NextIntlClientProvider locale="en" messages={messages}><SignerControls partId="part" revision={7} route={route} signing={signing} candidates={[{id:'replacement',name:'Fictional Alternate'},{id:'head',name:'Fictional Head'}]} canOverride={canOverride} onDirtyChange={m.dirty}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();m.replace.mockResolvedValue({ok:true});m.override.mockResolvedValue({ok:true});});
describe('reasoned probation signing assignments',()=>{
 it('does not offer employee acknowledgement or a completed signature for reassignment',()=>{
  show({tenantId:'tenant',companyId:'company',subjectId:'part',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route,actions:[{id:'signed-manager',stepId:'lm',role:'lm',actorId:'manager',actorPersonId:'manager-person',actorName:'Fictional Manager',representedId:'manager',at:'2026-11-03T00:00:00Z',action:'signed',comment:'',contentHash:'a'.repeat(64),contentRevision:1,signature:{method:'typed',value:'Fictional Manager',consent:true}}]});
  fireEvent.click(screen.getByText('Replace a pending signer'));const options=within(screen.getByRole('combobox',{name:'Signing step'})).getAllByRole('option').map(option=>(option as HTMLOptionElement).value);expect(options).toEqual(['','hod']);
 });
 it('retains the proposed replacement and audit reason when the native assignment is refused',async()=>{
  m.replace.mockResolvedValue({ok:false,detail:'The role holder changed. Review the current assignment.'});show();fireEvent.click(screen.getByText('Replace a pending signer'));
  fireEvent.change(screen.getByRole('combobox',{name:'Signing step'}),{target:{value:'hod'}});fireEvent.change(screen.getByRole('combobox',{name:'Replacement reason'}),{target:{value:'delegation'}});fireEvent.change(screen.getByRole('combobox',{name:'Existing authorized user'}),{target:{value:'replacement'}});fireEvent.change(screen.getByLabelText('Valid from'),{target:{value:'2026-11-03'}});fireEvent.change(screen.getByRole('textbox',{name:'Reason for the assignment or route change'}),{target:{value:'Planned absence reviewed by People Ops.'}});fireEvent.click(screen.getByRole('button',{name:'Record signer replacement'}));
  await screen.findByRole('alert');expect(m.replace).toHaveBeenCalledWith({partId:'part',stepId:'hod',holderId:'replacement',kind:'delegation',validFrom:'2026-11-03',validTo:null,reason:'Planned absence reviewed by People Ops.'});expect(screen.getByRole('combobox',{name:'Existing authorized user'})).toHaveValue('replacement');expect(m.refresh).not.toHaveBeenCalled();await waitFor(()=>expect(m.dirty).toHaveBeenLastCalledWith(true));
 });
 it('can discard an unsaved replacement without making a native mutation',async()=>{
  show();fireEvent.change(screen.getByRole('textbox',{name:'Reason for the assignment or route change'}),{target:{value:'Unsubmitted assignment draft'}});fireEvent.click(screen.getByRole('button',{name:'Discard unsaved changes'}));expect(screen.getByRole('textbox',{name:'Reason for the assignment or route change'})).toHaveValue('');expect(m.replace).not.toHaveBeenCalled();expect(m.override).not.toHaveBeenCalled();await waitFor(()=>expect(m.dirty).toHaveBeenLastCalledWith(false));
 });
});
