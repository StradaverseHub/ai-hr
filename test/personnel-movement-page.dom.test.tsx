import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {MovementActionShell} from '../app/admin/personnel/[employmentId]/movement-action-shell';
import {MovementHistoryActions,type MovementActionLabels} from '../app/admin/personnel/[employmentId]/movement-history-actions';
import {firstDirtyGuard,__resetUnsavedGuards} from '../lib/unsaved-changes';
import messages from '../messages/en.json';
const {push}=vi.hoisted(()=>({push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push})}));
const m=messages.people.detail.movement;
const labels:MovementActionLabels={view:m.view,edit:m.edit,delete:m.delete,deleteTitle:m.deleteTitle,deleteDescription:m.deleteDescription,deletePendingDescription:m.deletePendingDescription,keepEvent:m.keepEvent,reason:m.correctionReasonLabel,hireEdit:m.hireCorrection.action,hireDelete:m.hireDelete,hireRequirements:m.hireDeleteRequirements,unavailable:m.correctionUnavailable,unsupported:m.correctionUnsupported,terminal:m.correctionTerminal,viewOnly:m.correctionViewOnly,closedWarning:'Closed',closedAcknowledge:m.form.closedPayrollAcknowledge,processedWarning:'Processed'};
function mount(readOnly=false){return render(<NextIntlClientProvider locale="en" messages={messages}><MovementActionShell readOnly={readOnly}><form><label>Reason<input name="reason"/></label></form><a href="/admin/personnel/person?tab=careerMovement">Back</a></MovementActionShell></NextIntlClientProvider>);}
afterEach(()=>{cleanup();__resetUnsavedGuards();vi.restoreAllMocks();push.mockClear();});
describe('standalone personnel movement navigation',()=>{
 it('keeps draft on cancelled navigation and continues only after discard is confirmed',async()=>{
  const user=userEvent.setup(),confirm=vi.spyOn(window,'confirm').mockReturnValue(false);mount();
  await user.type(screen.getByRole('textbox',{name:'Reason'}),'Preserve my draft');
  expect(firstDirtyGuard()?.isDirty()).toBe(true);
  await user.click(screen.getByRole('link',{name:'Back'}));expect(confirm).toHaveBeenCalled();expect(push).not.toHaveBeenCalled();expect(screen.getByRole('textbox')).toHaveValue('Preserve my draft');
  confirm.mockReturnValue(true);await user.click(screen.getByRole('link',{name:'Back'}));expect(push).toHaveBeenCalledWith(expect.stringContaining('?tab=careerMovement'));expect(firstDirtyGuard()).toBeNull();
 });
 it('guards browser unload while dirty and has no dirty form guard on the read-only View page',()=>{
  mount();fireEvent.input(screen.getByRole('textbox'),{target:{value:'Changed'}});
  const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
  cleanup();__resetUnsavedGuards();mount(true);fireEvent.input(screen.getByRole('textbox'),{target:{value:'No edit'}});expect(firstDirtyGuard()).toBeNull();
 });
 it('keeps employee, correction visibility and origin on each dedicated action link',()=>{
  render(<NextIntlClientProvider locale="en" messages={messages}><MovementHistoryActions employmentId="person" row={{id:'hire-event',kind:'hired',status:'applied',canEdit:true,canReverse:false,payrollLocked:false,payrollWarning:false}} eventLabel="Hired" canCorrect labels={labels} reverseAction={async()=>{}} context={{showCorrected:'1',from:'org'}}/></NextIntlClientProvider>);
  expect(screen.getByRole('link',{name:labels.view})).toHaveAttribute('href','/admin/personnel/person/movement/view/hire-event?showCorrected=1&from=org');
  expect(screen.getByRole('link',{name:labels.edit})).toHaveAttribute('href','/admin/personnel/person/movement/edit/hire-event?showCorrected=1&from=org');
  expect(screen.getByRole('link',{name:labels.hireEdit})).toHaveAttribute('href','/admin/personnel/person/movement/correct-hire?showCorrected=1&from=org');
 });
});
