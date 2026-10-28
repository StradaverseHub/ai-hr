/** Authored UNRUN: browser-local explicit sheet scope; no action/provider/import is mocked as PASS. */
import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PersonnelImportWorkbookReview} from '../components/personnel-import-workbook-review';
import type {PersonnelWorkbookSource} from '../lib/personnel-import-assistance-source';
import en from '../messages/en.json';
const messages=en.people.import.headerAssistance.workbook;
const sheets=['Employees','Other HR','Family'].map(sheetName=>({sheetName,text:'Original heading\r\nPRIVATE value\r\n',source:{sheetName,rows:[{row:1,cells:[{column:1,raw:'Original heading',display:'Original heading',decoded:'Original heading',kind:'s'}]},{row:2,cells:[{column:1,raw:'PRIVATE value',display:'PRIVATE value',decoded:'PRIVATE value',kind:'s'}]}]}}));
const workbook:PersonnelWorkbookSource={sheets,decodedBytes:100,rangeCells:6};afterEach(cleanup);
describe('explicit worksheet scope review',()=>{
 it('requires a chosen employee sheet and acknowledgement of unassigned sheets while preserving the original companion',()=>{
  const onApply=vi.fn();render(<PersonnelImportWorkbookReview workbook={workbook} revisionId="local-1" knownRoles={{Family:'family'}} messages={messages} onApply={onApply} onCancel={vi.fn()}/>);
  const apply=screen.getByRole('button',{name:messages.apply});expect(apply).toBeDisabled();fireEvent.change(screen.getByRole('combobox',{name:`${messages.role}: Employees`}),{target:{value:'employee'}});expect(apply).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:messages.acknowledge}));expect(apply).toBeEnabled();fireEvent.click(apply);
  const[reviewed,revision]=onApply.mock.calls[0];expect(revision).toBe('local-1');expect(reviewed.employee.sheetName).toBe('Employees');expect(reviewed.companions.family).toBe(sheets[2].text);expect(reviewed.excluded).toEqual(['Other HR']);expect(reviewed.original).toBe(workbook);
 });
 it('never merges two employee sheets and resets acknowledgement after a role edit',()=>{
  render(<PersonnelImportWorkbookReview workbook={workbook} revisionId="local-1" knownRoles={{Family:'family'}} messages={messages} onApply={vi.fn()} onCancel={vi.fn()}/>);
  fireEvent.change(screen.getByRole('combobox',{name:`${messages.role}: Employees`}),{target:{value:'employee'}});fireEvent.click(screen.getByRole('checkbox',{name:messages.acknowledge}));
  fireEvent.change(screen.getByRole('combobox',{name:`${messages.role}: Other HR`}),{target:{value:'employee'}});expect(screen.getByRole('checkbox',{name:messages.acknowledge})).not.toBeChecked();expect(screen.getByRole('button',{name:messages.apply})).toBeDisabled();
 });
});
