import {useState} from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ScheduleShiftPicker,type ScheduleShiftChoice} from '../components/schedule-shift-picker';
afterEach(cleanup);
const shifts:ScheduleShiftChoice[]=[...Array.from({length:40},(_,index)=>({id:'shift-'+index,code:'S'+String(index).padStart(2,'0'),name:index<20?'Morning '+index:'Night '+index,startTime:'09:00',endTime:'18:00',archived:false,available:true})),
 {id:'old',code:'ARCHIVE',name:'Retained archived shift',startTime:null,endTime:null,archived:true,available:false},
 {id:'unused-old',code:'UNUSED',name:'Never selected archived shift',startTime:null,endTime:null,archived:true,available:false}];
function Harness({editing=true}:{editing?:boolean}){
 const [selected,setSelected]=useState(['shift-0','old']);
 return <NextIntlClientProvider locale="en" messages={en}><form aria-label="Pool form"><ScheduleShiftPicker shifts={shifts} selected={selected} onChange={setSelected} editing={editing}/></form></NextIntlClientProvider>;
}
const ids=()=>new FormData(screen.getByRole('form',{name:'Pool form'}) as HTMLFormElement).getAll('allowedShiftIds').map(String).sort();
describe('large active shift selection and preserved history',()=>{
 it('searches code/name without dropping filtered selections from submission',()=>{
  render(<Harness/>);expect(screen.getAllByRole('checkbox')).toHaveLength(40);expect(ids()).toEqual(['old','shift-0']);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'S21'}});
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);fireEvent.click(screen.getByRole('checkbox',{name:/Night 21/}));
  expect(ids()).toEqual(['old','shift-0','shift-21']);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Morning'}});expect(screen.getAllByRole('checkbox')).toHaveLength(20);
  expect(ids()).toEqual(['old','shift-0','shift-21']);expect(screen.getByRole('status')).toHaveTextContent('3 selected');
 });
 it('selects only active current search results, while Clear All explicitly clears the entire saved selection',()=>{
  render(<Harness/>);fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Night'}});
  fireEvent.click(screen.getByRole('button',{name:'Select all search results'}));expect(ids()).toHaveLength(22);expect(ids()).not.toContain('shift-1');
  expect(screen.getByRole('button',{name:'Select all search results'})).toBeDisabled();
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'No matching shift'}});
  expect(screen.getByText('No active shifts match this search.')).toBeVisible();expect(ids()).toHaveLength(22);
  fireEvent.click(screen.getByRole('button',{name:'Clear all selected shifts'}));expect(ids()).toEqual([]);
 });
 it('keeps archived selections separate and never offers archived references for new selection',()=>{
  render(<Harness/>);const active=screen.getByRole('group',{name:'Active shifts available for selection'});
  expect(within(active).queryByText(/archived shift/)).toBeNull();expect(screen.queryByText(/Never selected/)).toBeNull();
  const history=screen.getByRole('region',{name:'Retained unavailable shifts'});expect(within(history).getByText(/Retained archived shift/)).toBeVisible();
  fireEvent.click(within(history).getByRole('button',{name:/Remove ARCHIVE/}));expect(ids()).toEqual(['shift-0']);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'ARCHIVE'}});expect(screen.queryByRole('checkbox')).toBeNull();expect(ids()).toEqual(['shift-0']);
 });
 it('presents only selected records in view mode and provides no mutation controls',()=>{
  render(<Harness editing={false}/>);expect(screen.queryByRole('searchbox')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);expect(screen.getByRole('checkbox')).toBeDisabled();expect(ids()).toEqual(['old','shift-0']);
 });
});
