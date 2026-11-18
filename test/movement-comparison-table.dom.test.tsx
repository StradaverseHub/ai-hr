import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {MovementComparisonTable} from '../app/admin/personnel/[employmentId]/movement-comparison-table';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
afterEach(cleanup);
const rows=[{key:'department',label:'Department',before:'DP0005',after:'DP0005'},{key:'position',label:'Position',before:'EQUIPMENT CONTROLLER',after:'EQUIPMENT CONTROLLER'}];
const labels={field:'Field',before:'Before',after:'After',firstRecord:'First record'};
describe('retained exit employment information',()=>{
 it.each([['light',390],['dark',390],['light',1280],['dark',1280]])('renders historical context in %s theme at %ipx', (theme,width)=>{
  const copy=en.people.detail.movement.detail;
  render(<div className={String(theme)} style={{width:Number(width)}}><MovementComparisonTable rows={rows} hasBefore labels={labels} exit={{title:copy.exitInformation,note:copy.exitInformationNote.replace('{date}','13/10/2026'),column:copy.atExit}}/></div>);
  const table=screen.getByRole('table',{name:/Employment information at exit/});
  expect(table).toHaveTextContent('not a current assignment');
  expect(screen.getByRole('columnheader',{name:'At exit'})).toBeInTheDocument();
  const department=screen.getByRole('rowheader',{name:'Department'}).closest('tr')!;
  expect(within(department).getAllByRole('cell').map(cell=>cell.textContent)).toEqual(['DP0005','DP0005']);
  const position=screen.getByRole('rowheader',{name:'Position'}).closest('tr')!;
  expect(within(position).getAllByRole('cell').map(cell=>cell.textContent)).toEqual(['EQUIPMENT CONTROLLER','EQUIPMENT CONTROLLER']);
 });
 it('retains ordinary Before/After and first-record states without an exit claim',()=>{
  render(<MovementComparisonTable rows={rows} hasBefore={false} labels={labels}/>);
  expect(screen.getByRole('columnheader',{name:'After'})).toBeInTheDocument();
  expect(screen.getAllByText('First record')).toHaveLength(2);
  expect(screen.queryByText('Employment information at exit')).toBeNull();
 });
 it('has historical context and the date placeholder in every supported locale',()=>{
  for(const messages of [en,ms,zh,ta,th,vi]){
   const copy=messages.people.detail.movement.detail;
   expect(copy.exitInformation.trim()).not.toBe('');expect(copy.atExit.trim()).not.toBe('');
   expect(copy.exitInformationNote).toContain('{date}');
  }
 });
});
