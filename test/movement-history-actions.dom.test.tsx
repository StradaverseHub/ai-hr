import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {MovementHistoryActions,type MovementActionLabels} from '../app/admin/personnel/[employmentId]/movement-history-actions';
import {movementScreenAccess} from '../lib/movement-screen-access';
import messages from '../messages/en.json';
const m=messages.people.detail.movement;
const labels:MovementActionLabels={view:m.view,edit:m.edit,delete:m.delete,deleteTitle:m.deleteTitle,deleteDescription:m.deleteDescription,deletePendingDescription:m.deletePendingDescription,keepEvent:m.keepEvent,reason:m.correctionReasonLabel,hireEdit:m.hireCorrection.action,hireDelete:m.hireDelete,hireRequirements:m.hireDeleteRequirements,unavailable:m.correctionUnavailable,unsupported:m.correctionUnsupported,terminal:m.correctionTerminal,viewOnly:m.correctionViewOnly,closedWarning:'Payroll for 2026-10 is already closed.',closedAcknowledge:m.form.closedPayrollAcknowledge,processedWarning:m.form.payrollWarning};
const row={id:'fictional-exit',kind:'resignation',status:'applied' as const,canEdit:true,canReverse:true,payrollLocked:false,payrollWarning:false};
const action=vi.fn(async(_data:FormData)=>{});
function mount(overrides:Partial<Parameters<typeof MovementHistoryActions>[0]>={}){
 return render(<NextIntlClientProvider locale="en" messages={messages}><MovementHistoryActions employmentId="fictional-subject" row={row} eventLabel="Resignation · 13 Oct 2026" canCorrect={movementScreenAccess({admin:true,canMaintainWorkforce:true,terminatedOn:'2026-10-13'}).canCorrectMovement} labels={labels} reverseAction={action} {...overrides}/></NextIntlClientProvider>);
}
afterEach(()=>{cleanup();vi.clearAllMocks()});
describe('actual Movement history correction actions',()=>{
 it('retains View, Edit and Delete after exit while keeping New Event restricted',()=>{
  expect(movementScreenAccess({admin:true,canMaintainWorkforce:true,terminatedOn:'2026-10-13'})).toEqual({canCreateMovement:false,canCorrectMovement:true});
  mount();expect(screen.getByRole('link',{name:m.view})).toHaveAttribute('href',expect.stringContaining('movement=fictional-exit'));
  expect(screen.getByRole('link',{name:m.edit})).toHaveAttribute('href',expect.stringContaining('editMovement=fictional-exit'));
  expect(screen.getByRole('button',{name:m.delete})).toBeInTheDocument();
 });
 it('requires reason and closed-payroll acknowledgement on the actual Delete form',async()=>{
  const user=userEvent.setup(),{container}=mount({row:{...row,payrollLocked:true}});
  await user.click(screen.getByRole('button',{name:m.delete}));
  const dialog=screen.getByRole('alertdialog'),confirm=within(dialog).getByRole('button',{name:m.delete});
  expect(confirm).toBeDisabled();expect(within(dialog).getByText(m.deleteDescription)).toBeInTheDocument();
  await user.type(within(dialog).getByRole('textbox'),'Fictional incorrect resignation');expect(confirm).toBeDisabled();
  await user.click(within(dialog).getByRole('checkbox',{name:m.form.closedPayrollAcknowledge}));expect(confirm).toBeEnabled();
  const data=new FormData(container.querySelector('form')!);expect(data.get('employmentId')).toBe('fictional-subject');expect(data.get('movementId')).toBe('fictional-exit');expect(data.get('reason')).toBe('Fictional incorrect resignation');expect(data.get('acknowledgeClosedPayroll')).toBe('1');
 });
 it('explains a pending Delete as cancellation before it takes effect',async()=>{
  mount({row:{...row,status:'pending'}});await userEvent.setup().click(screen.getByRole('button',{name:m.delete}));
  expect(screen.getByText(m.deletePendingDescription)).toBeInTheDocument();
 });
 it('explains unsupported and terminal rows without providing a write',()=>{
  mount({row:{...row,canEdit:false,canReverse:false}});expect(screen.getByText(m.correctionUnsupported)).toBeInTheDocument();expect(screen.queryByRole('button',{name:m.delete})).toBeNull();expect(screen.queryByRole('link',{name:m.edit})).toBeNull();
 });
 it.each([{admin:false,canMaintainWorkforce:true},{admin:true,canMaintainWorkforce:false}])('does not grant correction controls for denied role/scope %s',access=>{
  const permissions=movementScreenAccess({...access,terminatedOn:null});expect(permissions.canCreateMovement).toBe(false);
  mount({canCorrect:permissions.canCorrectMovement});expect(screen.queryByRole('link',{name:m.edit})).toBeNull();expect(screen.queryByRole('button',{name:m.delete})).toBeNull();expect(screen.getByText(m.correctionViewOnly)).toBeInTheDocument();
 });
 it('offers hire correction and explains controlled removal instead of an ordinary Delete',()=>{
  mount({row:{...row,kind:'hired',canEdit:false,canReverse:false}});expect(screen.getByRole('link',{name:m.hireCorrection.action})).toBeInTheDocument();expect(screen.getByText(m.hireDeleteRequirements)).toBeInTheDocument();expect(screen.queryByRole('button',{name:m.delete})).toBeNull();
 });
 it('the real page uses separate creation/correction gates for row controls and both correction forms',()=>{
  const page=fs.readFileSync(path.resolve(__dirname,'../app/admin/personnel/[employmentId]/page.tsx'),'utf8');
  expect(page).toContain('movementScreenAccess({admin, canMaintainWorkforce, terminatedOn: emp.terminatedOn})');expect(page).toContain('canCorrect={canCorrectMovement}');
  expect(page).toContain('const editEventCard = canCorrectMovement &&');expect(page).toContain('canCorrectMovement && hireCorrection &&');
 });
});
