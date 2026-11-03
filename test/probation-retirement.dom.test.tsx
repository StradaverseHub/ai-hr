import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {RetireVersionControl} from '../app/lifecycle/probation/retire-version-control';
const m=vi.hoisted(()=>({read:vi.fn(),retire:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/lifecycle/probation/actions',()=>({readPublicationRetirement:m.read,retirePublication:m.retire}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:vi.fn()})}));
function open(){render(<NextIntlClientProvider locale="en" messages={messages}><RetireVersionControl companyId="company" kind="workflow" versionId="published-six" version={6} blocked={false}/></NextIntlClientProvider>);const details=screen.getByText('Retire published version 6').closest('details')!;details.open=true;fireEvent(details,new Event('toggle'));}
beforeEach(()=>{vi.clearAllMocks();m.read.mockResolvedValue({ok:true,result:{canRetire:true,expectedVersion:9}});m.retire.mockResolvedValue({ok:true,result:{id:'retired-ten',version:10}});});
describe('reasoned retirement of the active probation publication',()=>{
 it('sends the active publication and latest scoped revision, without overwriting the pinned body',async()=>{open();const reason=await screen.findByRole('textbox',{name:'Reason'}),button=screen.getByRole('button',{name:'Record retirement'});expect(button).toBeDisabled();fireEvent.change(reason,{target:{value:'The reviewed replacement will be published separately.'}});fireEvent.click(button);await waitFor(()=>expect(m.retire).toHaveBeenCalledWith({companyId:'company',kind:'workflow',versionId:'published-six',expectedVersion:9,reason:'The reviewed replacement will be published separately.'}));});
 it('preserves the entered reason when concurrent publication makes retirement stale',async()=>{m.retire.mockResolvedValue({ok:false,detail:'The current publication changed.'});open();const reason=await screen.findByRole('textbox',{name:'Reason'});fireEvent.change(reason,{target:{value:'Retire the reviewed version only.'}});fireEvent.click(screen.getByRole('button',{name:'Record retirement'}));await screen.findByRole('alert');expect(reason).toHaveValue('Retire the reviewed version only.');expect(m.refresh).not.toHaveBeenCalled();});
 it('never offers the mutation for a historical or unscoped version',async()=>{m.read.mockResolvedValue({ok:true,result:{canRetire:false,expectedVersion:0}});open();await screen.findByText('Only the current published version can be retired.');expect(screen.queryByRole('button',{name:'Record retirement'})).not.toBeInTheDocument();expect(m.retire).not.toHaveBeenCalled();});
});
