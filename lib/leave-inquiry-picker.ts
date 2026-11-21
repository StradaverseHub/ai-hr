import {InquiryQueryError,type InquiryParams} from './leave-inquiry-query';
import {EMPLOYEE_CHOICE_PAGE_SIZE,EMPLOYEE_CHOICE_MAX_PAGE_SIZE,type EmployeeChoiceInput,type EmployeeChoiceFilters} from './employee-choice';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** The Leave picker retains the existing JS lower/includes matcher, independent of ICU ordering. */
export function matchesLeaveInquiryPicker(row:{name:string;employeeCode:string|null},query:string){
 const q=query.trim().toLowerCase();return !q||row.name.toLowerCase().includes(q)||(row.employeeCode??'').toLowerCase().includes(q);
}
export function normalizeLeaveInquiryPicker(input:EmployeeChoiceInput){
 const value={...input},strings=['query','companyId','businessUnitId','departmentId','status','selectedId','labelMode'],numbers=['offset','limit'];
 if(Object.keys(value).some(key=>!strings.includes(key)&&!numbers.includes(key))
  ||strings.some(key=>key in value&&value[key as keyof EmployeeChoiceInput]!==undefined&&typeof value[key as keyof EmployeeChoiceInput]!=='string')
  ||numbers.some(key=>key in value&&value[key as keyof EmployeeChoiceInput]!==undefined&&typeof value[key as keyof EmployeeChoiceInput]!=='number'))throw new InquiryQueryError('Invalid employee filter');
 const filters:EmployeeChoiceFilters={query:value.query??'',companyId:value.companyId??'',businessUnitId:value.businessUnitId??'',departmentId:value.departmentId??'',status:value.status??''};
 if(['companyId','businessUnitId','departmentId'].some(key=>filters[key as keyof EmployeeChoiceFilters]&&!uuid.test(filters[key as keyof EmployeeChoiceFilters]))
  ||value.selectedId&&!uuid.test(value.selectedId)||!['','active','ended'].includes(filters.status)||value.labelMode!==undefined&&value.labelMode!=='names')throw new InquiryQueryError('Invalid employee filter');
 const offset=value.offset??0,limit=value.limit??EMPLOYEE_CHOICE_PAGE_SIZE;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>EMPLOYEE_CHOICE_MAX_PAGE_SIZE||!Number.isSafeInteger(offset+limit))throw new InquiryQueryError('Invalid employee page');
 return {filters,offset,limit,selectedId:value.selectedId};
}
/** Existing URL picker context is navigation state, never a financial filter or authority. */
export function leaveInquiryPickerInput(params:InquiryParams,selectedId?:string):EmployeeChoiceInput{
 const one=(key:string)=>{const value=params[key];if(Array.isArray(value))throw new InquiryQueryError('Invalid employee filter');return value;};
 return {query:one('pickerQ'),companyId:one('pickerCompany'),businessUnitId:one('pickerBusinessUnit'),departmentId:one('pickerDepartment'),status:one('pickerStatus') as EmployeeChoiceInput['status'],selectedId};
}
