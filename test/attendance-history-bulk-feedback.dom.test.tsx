import React from 'react';
import {beforeEach, expect, it, vi} from 'vitest';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {AttendanceHistoryRow} from '../packs/attendance/service';
const {bulk, refresh}=vi.hoisted(()=>({bulk:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/(app)/attendance/application-history/actions',()=>({attendanceHistoryBulkAction:bulk}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
import {AttendanceHistoryTable} from '../components/attendance-history-table';
const row:AttendanceHistoryRow={id:'request-a',employmentId:'employee-a',employee:'Fictional employee',employeeCode:'0007',companyId:'company-a',company:'Fictional company',attendanceDate:'2024-01-02',submittedAt:'2024-01-02T03:00:00Z',status:'pending',applicationType:'irregularity',requestKind:'short',selectable:true,currentStage:1,currentParticipantSlot:'slot-a',stages:null,templateName:null};
beforeEach(()=>{vi.clearAllMocks();});
function show(){render(<NextIntlClientProvider locale="en" messages={messages}><AttendanceHistoryTable rows={[row]} returnTo="/attendance/application-history"/></NextIntlClientProvider>);}
function open(){fireEvent.click(screen.getByRole('checkbox',{name:messages.attendanceHistory.selectPage}));const trigger=screen.getByRole('button',{name:messages.attendanceHistory.approveSelected});fireEvent.click(trigger);return trigger;}
it.each([
 ['saved',{id:row.id,status:'approved' as const},messages.attendanceHistory.statuses.approved],
 ['stale refusal',{id:row.id,status:'failed' as const,message:'This application is no longer available for your decision.'},'This application is no longer available for your decision.'],
])('brings the %s outcome into keyboard focus beside the bulk controls',async(_name,outcome,copy)=>{
 bulk.mockResolvedValue([outcome]);show();const trigger=open();
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:messages.attendanceHistory.confirm}));
 const heading=await screen.findByRole('heading',{name:messages.attendanceHistory.results});
 await waitFor(()=>expect(heading).toHaveFocus());
 expect(trigger).toBeDisabled();expect(screen.queryByRole('dialog')).toBeNull();
 const results=heading.closest('section')!;expect(results).toHaveTextContent('Fictional employee');expect(results).toHaveTextContent(copy);
 // The result must precede the table; a long page cannot hide it behind every row.
 expect(results.compareDocumentPosition(screen.getByRole('table'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(bulk).toHaveBeenCalledWith({items:[{id:row.id,stage:1,participantSlot:'slot-a'}],decision:'approved',reason:''});expect(refresh).toHaveBeenCalledOnce();
});
it('returns focus and preserves selection when the confirmation is cancelled',async()=>{
 show();const trigger=open();fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:messages.attendanceHistory.cancel}));
 await waitFor(()=>expect(trigger).toHaveFocus());expect(trigger).toBeEnabled();expect(screen.getByRole('checkbox',{name:messages.attendanceHistory.selectPage})).toBeChecked();expect(bulk).not.toHaveBeenCalled();expect(screen.queryByRole('heading',{name:messages.attendanceHistory.results})).toBeNull();
});

it.each(['all_required', 'any_one', 'sequential'] as const)('renders the frozen %s approval requirement in the history row', mode => {
 const progress = {state:'pending' as const,level:1,mode,next:[]};
 render(<NextIntlClientProvider locale="en" messages={messages}><AttendanceHistoryTable rows={[{...row,progress}]} returnTo="/attendance/application-history"/></NextIntlClientProvider>);
 const expected=mode==='all_required'?messages.attendanceHistory.modeAllRequired:mode==='sequential'?messages.attendanceHistory.modeSequential:messages.attendanceHistory.modeAnyOne;
 expect(screen.getByRole('table')).toHaveTextContent(expected);
 if(mode==='all_required')expect(screen.getByRole('table')).not.toHaveTextContent(messages.attendanceHistory.modeAnyOne);
});
