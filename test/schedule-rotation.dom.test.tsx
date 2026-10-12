import { afterEach,describe,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';
import { ScheduleRotationEditor } from '../components/schedule-rotation-editor';
vi.mock('../app/admin/attendance/schedule/rotation-actions',()=>({saveRotationAction:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const date=new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
function mount(){return render(<NextIntlClientProvider locale="en" messages={messages}><ScheduleRotationEditor
  ruleId="group" revision="revision" minimumDate={date} editing
  initial={{unit:'day',length:2,effectiveFrom:date,anchorDate:date,days:[{kind:'full',shiftId:'a'},{kind:'rest',shiftId:null}]}}
  shifts={['a','b'].map(id=>({id,name:id==='a'?'Morning':'Night',code:id,startTime:'08:00',endTime:'17:00',halfEnd:'12:30',fullMinutes:480,halfMinutes:240,archived:false,available:true,selected:id==='a'}))}/></NextIntlClientProvider>);}
describe('integrated allowed-shift and cycle editor',()=>{
  it('makes an unsaved allowed shift immediately available in cycle selectors',()=>{
    const {container}=mount();
    fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    const select=screen.getByRole('combobox',{name:'Shift 1'});
    expect(within(select).getByRole('option',{name:'b · Night'})).toBeTruthy();
    fireEvent.change(select,{target:{value:'b'}});
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days[0].shiftId).toBe('b');
    expect((screen.getByRole('button',{name:messages.admin.rotation.save}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('warns before shrinking and preserves the full configured cycle when declined',()=>{
    const {container}=mount();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1'}});
    fireEvent.click(screen.getByRole('button',{name:messages.admin.rotation.generate}));
    expect(confirm).toHaveBeenCalledWith(messages.admin.rotation.replaceConfirm);
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days).toHaveLength(2);
  });
  it('removes working shift from rest/off and refuses an invalid working day pool',()=>{
    const {container}=mount();
    fireEvent.change(screen.getByRole('combobox',{name:'Day type 1'}),{target:{value:'off'}});
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days[0]).toEqual({kind:'off',shiftId:null});
    expect((screen.getByRole('button',{name:messages.admin.rotation.save}) as HTMLButtonElement).disabled).toBe(true);
  });
});
