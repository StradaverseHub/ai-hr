import {useState} from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ScheduleShiftPicker,type ScheduleShiftChoice} from '../components/schedule-shift-picker';

afterEach(cleanup);
const shifts:ScheduleShiftChoice[]=[
 ...Array.from({length:122},(_,index)=>({id:'shift-'+index,code:'S'+String(index).padStart(3,'0'),
  name:index<100?'Morning '+index:'Night '+index,archived:false,available:true})),
 {id:'old',code:'ARCHIVE',name:'Retained archived shift',archived:true,available:false},
 {id:'unused-old',code:'UNUSED',name:'Never selected archived shift',archived:true,available:false},
];
function Harness({editing=true,existing=true}:{editing?:boolean;existing?:boolean}){
 const [selected,setSelected]=useState(existing?['shift-0','old']:[]);
 return <NextIntlClientProvider locale="en" messages={en}><form aria-label="Pool form">
  <ScheduleShiftPicker shifts={shifts} selected={selected} onChange={setSelected} editing={editing}/>
 </form></NextIntlClientProvider>;
}
const ids=()=>new FormData(screen.getByRole('form',{name:'Pool form'}) as HTMLFormElement).getAll('allowedShiftIds').map(String).sort();
const pool=(side:'Excluded'|'Included')=>within(screen.getByRole('region',{name:new RegExp('^'+side)}));
describe('Schedule Group shift transfer',()=>{
 it('starts all active shifts excluded and shows counts for more than 100 shifts',()=>{
  render(<Harness existing={false}/>);
  expect(pool('Excluded').getByRole('heading')).toHaveTextContent('122 shifts');
  expect(pool('Included').getByRole('heading')).toHaveTextContent('0 shifts');
  expect(ids()).toEqual([]);
 });
 it('moves one or several checked shifts while search never loses the saved set',()=>{
  render(<Harness/>);
  expect(ids()).toEqual(['old','shift-0']);
  fireEvent.change(screen.getByRole('searchbox',{name:'Search excluded shifts'}),{target:{value:'Night'}});
  fireEvent.click(pool('Excluded').getByRole('checkbox',{name:/Night 101/}));
  fireEvent.click(pool('Excluded').getByRole('checkbox',{name:/Night 102/}));
  fireEvent.click(screen.getByRole('button',{name:/Include 2 selected/}));
  expect(ids()).toEqual(['old','shift-0','shift-101','shift-102']);
  fireEvent.change(screen.getByRole('searchbox',{name:'Search included shifts'}),{target:{value:'S102'}});
  fireEvent.click(pool('Included').getByRole('checkbox',{name:/Night 102/}));
  fireEvent.click(screen.getByRole('button',{name:/Exclude 1 selected/}));
  expect(ids()).toEqual(['old','shift-0','shift-101']);
  expect(pool('Included').getByRole('heading')).toHaveTextContent('2 shifts');
  expect(pool('Included').getByText('No shifts match the search.')).toBeVisible();
 });
 it('keeps archived selections separate and never offers archived references for new selection',()=>{
  render(<Harness/>);
  expect(pool('Excluded').queryByText(/archived shift/)).toBeNull();
  expect(screen.queryByText(/Never selected/)).toBeNull();
  const history=screen.getByRole('region',{name:'Retained unavailable shifts'});
  expect(within(history).getByText(/Retained archived shift/)).toBeVisible();
  fireEvent.click(within(history).getByRole('button',{name:/Remove ARCHIVE/}));
  expect(ids()).toEqual(['shift-0']);
 });
 it('presents selected records in view mode without mutation controls',()=>{
  render(<Harness editing={false}/>);
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('region',{name:/^Excluded/})).toBeNull();
  expect(pool('Included').getByText(/Morning 0/)).toBeVisible();
  expect(ids()).toEqual(['old','shift-0']);
 });
});
