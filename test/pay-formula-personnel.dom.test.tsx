import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {PersonnelFormulaLibrary} from '../app/payroll/formula-builder/personnel-library';
import type {PersonnelFormulaLibraryField} from '../lib/pay-formula-personnel';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/payroll/formula-builder/actions',()=>({registerPersonnelFormulaFieldAction:vi.fn()}));
afterEach(cleanup);
const company:PersonnelFormulaLibraryField={fieldId:'employment.organisation_assignment.companyname',key:'companyId',label:'Company',labelKey:'unknown',section:'Organisation assignment',group:'profile',type:'choice',history:'dated',sensitivity:'personnel',grain:'single',unavailableReason:null,description:'Verified legal employer',formulaType:'string',functionCode:'EmployeeProfile',dateBasis:'effective-date',enabled:true,listValues:[{value:'company-uuid',label:'Example company · company-uuid'}]};
it('inserts the typed source and permitted stable literal and keeps unsupported fields visible with a reason',()=>{
 const insert=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><PersonnelFormulaLibrary fields={[company,{...company,fieldId:'repeat',key:'repeat',label:'Emergency contacts',grain:'many',enabled:false,unavailableReason:'repeating',listValues:[]}]} search="" category="" disabled={false} onInsert={insert}/></NextIntlClientProvider>);
 const field=screen.getByRole('heading',{name:'Company'}).closest('article')!;fireEvent.click(within(field).getByRole('button',{name:en.payFormula.personnelLibrary.insertField}));expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({kind:'call',code:'EmployeeProfile',args:[expect.objectContaining({value:{type:'string',value:'companyId'}})]}));
 fireEvent.click(screen.getByText(en.payFormula.personnelLibrary.permittedValues));fireEvent.click(screen.getByRole('button',{name:'Example company · company-uuid'}));expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({kind:'literal',value:{type:'string',value:'company-uuid'}}));
 const repeat=screen.getByRole('heading',{name:'Emergency contacts'}).closest('article')!;expect(within(repeat).getByText(en.payFormula.personnelLibrary.reasons.repeating)).toBeVisible();expect(within(repeat).getByRole('button').hasAttribute('disabled')).toBe(true);
});
