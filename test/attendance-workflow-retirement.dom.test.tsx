import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const {retire,restore,archive,router}=vi.hoisted(()=>({retire:vi.fn(),restore:vi.fn(),archive:vi.fn(),router:{push:vi.fn(),refresh:vi.fn()}}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('../app/admin/attendance/approval-workflow/actions',()=>({retireAttendanceWorkflowAction:retire,restoreAttendanceWorkflowAction:restore,archiveAttendanceWorkflowAction:archive}));
import {WorkflowRetirementControls} from '../app/admin/attendance/approval-workflow/retirement-controls';
const props={lineageId:'fictional-lineage',version:7,name:'Fictional Attendance route',company:'Fictional Company'};
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
const show=(retired=false)=>render(<NextIntlClientProvider locale="en" messages={en}><WorkflowRetirementControls {...props} retired={retired}/></NextIntlClientProvider>);
it('names the workflow and company and allows cancellation without a mutation',()=>{show();fireEvent.click(screen.getByRole('button',{name:'Delete'}));const dialog=screen.getByRole('alertdialog');expect(dialog).toHaveAccessibleName('Delete Fictional Attendance route?');expect(within(dialog).getByText(/Fictional Company/)).toBeVisible();fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));expect(retire).not.toHaveBeenCalled();expect(screen.queryByRole('alertdialog')).toBeNull();});
it('posts the observed version at confirmation and keeps a dependency refusal visible without navigation',async()=>{retire.mockResolvedValue({ok:false,error:en.attendanceWorkflow.v4.usedCannotDelete});show();fireEvent.click(screen.getByRole('button',{name:'Delete'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Delete'}));expect(await screen.findByRole('alert')).toHaveTextContent(en.attendanceWorkflow.v4.usedCannotDelete);expect(retire).toHaveBeenCalledExactlyOnceWith(props.lineageId,7);expect(router.push).not.toHaveBeenCalled();await waitFor(()=>expect(screen.getByRole('button',{name:'Delete'})).not.toBeDisabled());});
it('shows a successful deletion through the company list receipt and restores retained configuration separately',async()=>{retire.mockResolvedValue({ok:true,companyId:'fictional-company',applicationType:'irregularity'});show();fireEvent.click(screen.getByRole('button',{name:'Delete'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Delete'}));await waitFor(()=>expect(router.push).toHaveBeenCalledWith('/admin/attendance/approval-workflow?companyId=fictional-company&applicationType=irregularity&notice=deleted'));expect(router.refresh).toHaveBeenCalledOnce();cleanup();vi.clearAllMocks();restore.mockResolvedValue({ok:true,lineageId:props.lineageId});show(true);fireEvent.click(screen.getByRole('button',{name:'Restore configuration'}));await waitFor(()=>expect(restore).toHaveBeenCalledExactlyOnceWith(props.lineageId,7));expect(retire).not.toHaveBeenCalled();});

it('offers Archive for used workflows and preserves the selected version on confirmation',async()=>{
 archive.mockResolvedValue({ok:true,companyId:'fictional-company',applicationType:'irregularity'});
 render(<NextIntlClientProvider locale="en" messages={en}><WorkflowRetirementControls {...props} used/></NextIntlClientProvider>);
 expect(screen.queryByRole('button',{name:'Delete'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Archive'}));
 fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Archive'}));
 await waitFor(()=>expect(archive).toHaveBeenCalledExactlyOnceWith(props.lineageId,7));
 expect(retire).not.toHaveBeenCalled();
});
