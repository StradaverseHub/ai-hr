import {useState} from 'react';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import {AllowanceEmployeePicker} from '../components/allowance-employee-picker';
import type {AllowanceEmployeePageInput} from '../core/attendance-allowance-selection';
const {search}=vi.hoisted(()=>({search:vi.fn()}));
vi.mock('../app/(app)/admin/attendance-allowance/actions',()=>({searchAllowanceEmployees:search}));
const catalogue=Array.from({length:120},(_,i)=>({id:`employee-${i+1}`,code:`F${String(i+1).padStart(3,'0')}`,name:`Fictional employee ${String(i+1).padStart(3,'0')}`,department:'Fictional department',businessUnit:'Fictional business unit'}));
function Harness({initial=[]}:{initial?:string[]}) {
 const [values,setValues]=useState(initial);
 return <NextIntlClientProvider locale="en" messages={en}><AllowanceEmployeePicker companyId="fictional-company" values={values} onChange={setValues}/><output data-testid="included-ids">{JSON.stringify(values)}</output></NextIntlClientProvider>;
}
const available=()=>within(screen.getByRole('region',{name:'Available'}));
const included=()=>within(screen.getByRole('region',{name:'Included'}));
beforeEach(()=>{
 search.mockReset();search.mockImplementation(async({query,page,side,included}:AllowanceEmployeePageInput)=>{
  const pool=catalogue.filter(row=>(side==='included'?included.includes(row.id):!included.includes(row.id))&&`${row.code} ${row.name}`.toLowerCase().includes(query.toLowerCase()));
  return{rows:pool.slice((page-1)*25,page*25),total:pool.length,page,unavailable:side==='included'?included.filter(id=>!catalogue.some(row=>row.id===id)):[]};
 });
});
it('keeps checked people across pages and separate pane searches before including or removing them',async()=>{
 render(<Harness/>);
 await available().findByRole('checkbox',{name:/Fictional employee 001/});
 expect(available().getAllByRole('checkbox')).toHaveLength(26);
 fireEvent.click(available().getByRole('checkbox',{name:/Fictional employee 001/}));
 fireEvent.click(available().getByRole('button',{name:'Next'}));
 await available().findByRole('checkbox',{name:/Fictional employee 026/});
 fireEvent.click(available().getByRole('checkbox',{name:/Fictional employee 026/}));
 fireEvent.change(available().getByRole('searchbox'),{target:{value:'F120'}});
 await available().findByRole('checkbox',{name:/Fictional employee 120/});
 fireEvent.click(available().getByRole('checkbox',{name:/Fictional employee 120/}));
 expect(screen.getByRole('button',{name:'Include checked (3)'})).not.toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Include checked (3)'}));
 await included().findByRole('checkbox',{name:/Fictional employee 001/});
 expect(JSON.parse(screen.getByTestId('included-ids').textContent!)).toEqual(['employee-1','employee-26','employee-120']);
 fireEvent.change(included().getByRole('searchbox'),{target:{value:'F026'}});
  await included().findByRole('checkbox',{name:/Fictional employee 026/});
  expect(included().queryByRole('checkbox',{name:/Fictional employee 001/})).toBeNull();
 fireEvent.click(included().getByRole('checkbox',{name:/Fictional employee 026/}));
 fireEvent.click(screen.getByRole('button',{name:'Remove checked (1)'}));
 expect(JSON.parse(screen.getByTestId('included-ids').textContent!)).toEqual(['employee-1','employee-120']);
 expect(available().getByRole('searchbox')).toHaveValue('F120');
 expect(included().getByRole('searchbox')).toHaveValue('F026');
 fireEvent.click(screen.getByRole('button',{name:'Clear included'}));
 expect(screen.getByTestId('included-ids')).toHaveTextContent('[]');
});
it('selects only the visible page and can explicitly remove an unavailable saved reference',async()=>{
 render(<Harness initial={['unavailable-reference']}/>);
 await available().findByRole('checkbox',{name:/Fictional employee 001/});
 fireEvent.click(available().getByRole('checkbox',{name:'Select visible (25)'}));
 fireEvent.click(screen.getByRole('button',{name:'Include checked (25)'}));
 expect(JSON.parse(screen.getByTestId('included-ids').textContent!)).toHaveLength(26);
 expect(JSON.parse(screen.getByTestId('included-ids').textContent!)).not.toContain('employee-26');
 await included().findByRole('checkbox',{name:'unavailable-reference'});
 fireEvent.click(included().getByRole('checkbox',{name:'unavailable-reference'}));
 fireEvent.click(screen.getByRole('button',{name:'Remove checked (1)'}));
 expect(JSON.parse(screen.getByTestId('included-ids').textContent!)).not.toContain('unavailable-reference');
});
it('ignores a late search response after the user has entered another query',async()=>{
 let resolve!:(value:unknown)=>void;
 search.mockImplementation(async(input:AllowanceEmployeePageInput)=>input.side==='available'&&input.query==='old'?new Promise(done=>{resolve=done;}):{rows:input.side==='available'?[catalogue[119]]:[],total:input.side==='available'?1:0,unavailable:[]});
 render(<Harness/>);
 await available().findByRole('checkbox',{name:/Fictional employee 120/});
 fireEvent.change(available().getByRole('searchbox'),{target:{value:'old'}});
 await waitFor(()=>expect(resolve).toBeTypeOf('function'));
 fireEvent.change(available().getByRole('searchbox'),{target:{value:'new'}});
 await available().findByRole('checkbox',{name:/Fictional employee 120/});
 await act(async()=>resolve({rows:[catalogue[0]],total:1,unavailable:[]}));
 expect(available().queryByRole('checkbox',{name:/Fictional employee 001/})).toBeNull();
 expect(available().getByRole('searchbox')).toHaveValue('new');
});
