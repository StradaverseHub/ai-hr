import {withTenant,type SessionContext} from '../db/client';
import {readEmployeeChoicesTx,EmployeeChoiceInputError} from './employee-choice';
import {employeePickerSubjectTx} from './read';
import {isAdmin} from '../lib/authz-model';
import {EmployeeChoiceAccessError} from './employee-choice';
import type {EmployeeChoiceInput} from '../lib/employee-choice';
export type SharedEmployeePickerPurpose='scoped'|'active'|'loans';
/** Page/header and choice populations are independent: status/search never erases an otherwise valid selection. */
export async function sharedEmployeePicker(ctx:SessionContext,companyIds:readonly string[],purpose:SharedEmployeePickerPurpose,input:EmployeeChoiceInput={}){
 if(!isAdmin(ctx))throw new EmployeeChoiceAccessError('Administration access required');
 const scope=purpose==='loans'?[]:companyIds.slice();
 return withTenant(ctx,async tx=>{
  const choices=await readEmployeeChoicesTx(tx,ctx,{...input,companyIds:scope,...(purpose==='active'?{activeOnly:true as const}:{}),limit:25});
  const subject=await employeePickerSubjectTx(tx,input.selectedId,scope);
  return {choices,subject:purpose==='active'&&subject?.terminatedOn?null:subject};
 },{readOnlySnapshot:true});
}
/** Later pages need no rich selected header or person identity. */
export async function sharedEmployeePickerPage(ctx:SessionContext,companyIds:readonly string[],purpose:SharedEmployeePickerPurpose,input:EmployeeChoiceInput){
 if(!isAdmin(ctx))throw new EmployeeChoiceAccessError('Administration access required');
 if(input.limit!==undefined&&input.limit!==25)throw new EmployeeChoiceInputError('Invalid picker page size');
 return withTenant(ctx,tx=>readEmployeeChoicesTx(tx,ctx,{...input,companyIds:purpose==='loans'?[]:companyIds.slice(),...(purpose==='active'?{activeOnly:true as const}:{}),limit:25}),{readOnlySnapshot:true});
}
