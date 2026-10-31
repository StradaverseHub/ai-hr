import { describe,expect,it,vi } from 'vitest';
import { render,screen,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { AttendanceDateOvertime } from '../components/attendance-day-editor';
import type { AttendanceDayEditorData } from '../packs/attendance/service';
import en from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';

const {save,refresh}=vi.hoisted(()=>({save:vi.fn(async(_data:FormData)=>({ok:true})),refresh:vi.fn()}));
vi.mock('../app/(app)/attendance/individual/[date]/actions',()=>({saveAttendanceDayChangesAction:save,adminCorrectAttendanceDayAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
vi.mock('sonner',()=>({toast:{success:vi.fn()}}));

const data=()=>({baseline:'reviewed',closed:false,self:false,processed:false,complete:true,approvedOtMinutes:null,history:[],rows:[{
  key:'removed-band',fromMinutes:0,toMinutes:null,ratePattern:'variable',rate:0,bucket:'ot20',calculatedMinutes:0,
  effectiveMinutes:90,autoEffectiveMinutes:0,orphan:true,
  manual:{minutes:90,calculatedMinutes:120,recordedAt:new Date().toISOString(),bucket:'ot20'},
}]} as unknown as AttendanceDayEditorData);
const show=()=>render(<NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en} onError={e=>{throw e;}}>
  <AttendanceDateOvertime data={data()} employmentId="employee" date={todayInKualaLumpur()}/>
</NextIntlClientProvider>);

describe('dated manual decision whose configured band was removed',()=>{
  it('shows unavailable configuration/calculation while preserving the original and effective decision',()=>{
    show();const row=screen.getAllByRole('row')[1],cells=within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent(en.attendance.dayEdit.orphan);
    expect(cells[0]).not.toHaveTextContent('OT 0×');
    expect(cells[0]).toHaveTextContent('2h');
    expect(cells[1]).toHaveTextContent('—');
    expect(cells[4]).toHaveTextContent('1h 30m');
    expect(screen.getByRole('spinbutton')).toBeDisabled();
  });
  it('allows explicitly returning that decision to Auto and submits only that row',async()=>{
    const user=userEvent.setup();show();
    await user.click(screen.getByRole('button',{name:en.attendance.dayEdit.resetAuto}));
    await user.type(screen.getByRole('textbox'), 'Band removed: reviewed');
    await user.click(screen.getByRole('button',{name:en.attendance.dayEdit.saveOvertime}));
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(save.mock.calls[0][0].get('rows') as string)).toEqual([{key:'removed-band',minutes:null}]);
    expect(refresh).toHaveBeenCalled();
  });
});
