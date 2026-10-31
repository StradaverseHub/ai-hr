// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PermissionMatrix} from '../app/(app)/admin/settings/profile-requests/permission-matrix';
afterEach(cleanup);
const labels={editable:'Editable',viewOnly:'View Only',hide:'Hide',field:'Field',all:'Select all',primaryOnly:'Primary only',waiting:'Waiting',groupHelp:'Group limits take priority',tabPermission:'Tab access',sectionPermission:'Section access'};
const baseRows=[{id:'name',label:'Name',group:'Profile',canEdit:true,permission:'editable' as const,primaryOnly:false,waiting:1},{id:'contact',label:'Contact',group:'Emergency Contacts',canEdit:true,permission:'viewOnly' as const,primaryOnly:true,waiting:0},{id:'salary',label:'Salary',group:'Payroll',canEdit:false,permission:'viewOnly' as const,primaryOnly:false,waiting:0}];
const rows=baseRows.map(row=>({...row,tab:row.group==='Payroll'?'Payroll':'Profile',section:row.group,tabLabel:row.group==='Payroll'?'Payroll':'Profile'}));
describe('ESS permission checkbox matrix',()=>{
 it('checking another permission clears the competing value; unchecking leaves an invalid draft for the server to refuse',()=>{
  const {container}=render(<form><PermissionMatrix rows={rows} disabled={false} labels={labels}/></form>);
  fireEvent.click(screen.getByLabelText('Name: Hide'));
  expect((screen.getByLabelText('Name: Editable') as HTMLInputElement).checked).toBe(false);
  expect(new FormData(container.querySelector('form')!).get('permission:name')).toBe('hide');
  fireEvent.click(screen.getByLabelText('Name: Hide'));
  expect(new FormData(container.querySelector('form')!).get('permission:name')).toBe('');
 });
 it('keeps finite primary-only rights on an unchanged save and closes them on an explicit selection',()=>{
  const {container}=render(<form><PermissionMatrix rows={rows} disabled={false} labels={labels}/></form>);
  expect(new FormData(container.querySelector('form')!).getAll('primaryOnly')).toEqual(['contact']);
  fireEvent.click(screen.getByLabelText('Contact: Hide'));
  expect(new FormData(container.querySelector('form')!).getAll('primaryOnly')).toEqual([]);
 });
 it('shows mixed aggregate state and never enables a specialist write via select-all',()=>{
  render(<PermissionMatrix rows={rows} disabled={false} labels={labels}/>);
  expect(screen.getByLabelText('Select all: Editable').getAttribute('aria-checked')).toBe('mixed');
  fireEvent.click(screen.getByLabelText('Select all: Editable'));
  expect((screen.getByLabelText('Contact: Editable') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Salary: Editable') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Salary: Editable') as HTMLInputElement).checked).toBe(false);
 });
});

it('posts tab and section caps without destroying the underlying field choice',()=>{
 const {container}=render(<form><PermissionMatrix rows={rows} disabled={false} labels={labels}/></form>);
 fireEvent.change(screen.getByLabelText('Profile: Tab access'),{target:{value:'hide'}});
 const data=new FormData(container.querySelector('form')!);expect(data.get('groupPermission:tab:Profile')).toBe('hide');expect(data.get('permission:name')).toBe('editable');
 fireEvent.change(screen.getByLabelText('Profile: Tab access'),{target:{value:'editable'}});
 expect(new FormData(container.querySelector('form')!).get('permission:name')).toBe('editable');
});
