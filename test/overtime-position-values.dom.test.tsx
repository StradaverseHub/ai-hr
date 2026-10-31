import {afterEach,describe,expect,it,vi} from 'vitest';
import {useState} from 'react';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OvertimePositionValues} from '../components/overtime-patterns/position-values';
const load=vi.hoisted(()=>vi.fn());
vi.mock('../app/(app)/admin/attendance/settings/overtime-patterns/actions',()=>({overtimePositionChoicesAction:load}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const choices=Array.from({length:500},(_,index)=>({id:'position-'+index,label:'Position '+index}));
function Harness(){const [selected,setSelected]=useState(['position-0']);return <NextIntlClientProvider locale="en" messages={messages}><OvertimePositionValues options={choices} selected={selected} onChange={setSelected}/></NextIntlClientProvider>;}
describe('paged Overtime position choices',()=>{
 it('loads choices beyond 500 while retaining the current selection',async()=>{
  const user=userEvent.setup();load.mockResolvedValue({ok:true,value:{items:[{id:'position-526',label:'Final position'}],nextCursor:null}});render(<Harness/>);
  await user.click(screen.getByRole('button',{name:'Load more positions'}));expect(load).toHaveBeenCalledWith({search:'',cursor:'position-499',selectedIds:['position-0']});expect(screen.getByRole('option',{name:'Position 0'})).toHaveProperty('selected',true);await user.selectOptions(screen.getByRole('listbox'),['position-0','position-526']);expect(screen.getByRole('option',{name:'Final position'})).toHaveProperty('selected',true);expect(screen.queryByRole('button',{name:'Load more positions'})).toBeNull();
 });
 it('resolves a saved off-page selection instead of dropping its value',async()=>{
  load.mockResolvedValue({ok:true,value:{items:[{id:'off-page',label:'Saved position'}],nextCursor:null}});
  render(<NextIntlClientProvider locale="en" messages={messages}><OvertimePositionValues options={choices} selected={['off-page']} onChange={vi.fn()}/></NextIntlClientProvider>);
  await waitFor(()=>expect(screen.getByRole('option',{name:'Saved position'})).toHaveProperty('selected',true));expect(load).toHaveBeenCalledWith({selectedIds:['off-page']});
 });
});
