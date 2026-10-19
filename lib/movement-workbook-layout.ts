/** Workbook presentation only. Applicable inputs remain owned by the canonical New Event contract. */
import {movementFormFields,MOVEMENT_FORM_IDS,type MovementFormField} from './movement-form-contract';
import {personnelFormField} from './personnel-form-contract';
import {personnelFieldLabel,type PersonnelLabelResolver} from './personnel-import-contract';
export type MovementWorkbookType={code:string;label:string|null;behaviour:string};
export type MovementWorkbookColumn={key:string;label:string;role:'identity'|'current'|'input'|'formula';field?:MovementFormField;other?:boolean};
const main:Record<string,string[]>={increment:['incrementAmount'],salaryAdjustment:['basicSalary'],promotion:['positionId','gradeId','incrementAmount','managerEmploymentId'],demotion:['positionId','gradeId','basicSalary'],confirmation:['incrementAmount'],probationExtension:['endDate'],actingPosition:['endDate'],secondment:['endDate'],transfer:['businessUnitId','departmentId','locationId','managerEmploymentId'],orgAssignmentChange:['businessUnitId','departmentId','positionId','locationId'],entityTransfer:['companyId','businessUnitId','departmentId','positionId','locationId','managerEmploymentId'],employmentTypeChange:['employmentType'],reportingLineChange:['managerEmploymentId'],resignation:['endDate'],termination:['terminationReasonCode','resignationDate','terminationNoticeDays','endDate'],blacklist:['blacklisted'],joinDateChange:[],groupJoinDateCorrection:[]};
const grey:Record<string,string[]>={increment:['departmentId','gradeId','basicSalary','currency'],salaryAdjustment:['basicSalary','currency'],promotion:['positionId','gradeId','basicSalary','currency','managerEmploymentId'],demotion:['positionId','gradeId','basicSalary','currency'],confirmation:['joinDate','probationEndDate','basicSalary','currency'],probationExtension:['joinDate','probationEndDate'],actingPosition:['positionId'],secondment:['departmentId','locationId'],transfer:['businessUnitId','departmentId','locationId','managerEmploymentId'],orgAssignmentChange:['businessUnitId','departmentId','positionId','locationId'],entityTransfer:['companyId','departmentId','positionId','managerEmploymentId'],employmentTypeChange:['employmentType'],reportingLineChange:['managerEmploymentId'],resignation:['joinDate'],termination:['joinDate'],blacklist:['blacklistedAt'],joinDateChange:['joinDate'],groupJoinDateCorrection:['hiredOn']};
export function movementWorkbookLayout(type:MovementWorkbookType,resolve:PersonnelLabelResolver):MovementWorkbookColumn[]{
 const word=(key:string,fallback:string)=>resolve('people.import.movement.v2.'+key,fallback);
 const label=(field:string)=>field in MOVEMENT_FORM_IDS?personnelFieldLabel(personnelFormField(MOVEMENT_FORM_IDS[field as MovementFormField]),resolve):field==='probationEndDate'?'Probation End Date':field==='joinDate'?'Join Date':field==='hiredOn'?'Group Join Date':field==='blacklistedAt'?'Blacklist':field;
 const applicable=movementFormFields(type.behaviour,'resignation').filter(f=>f!=='kind');
 const fields=(main[type.behaviour]??['endDate']).filter(f=>f==='incrementAmount'||applicable.includes(f as MovementFormField));
 const columns:MovementWorkbookColumn[]=[{key:'employeeCode',label:word('employeeId','Employee ID'),role:'identity'},{key:'employeeName',label:word('employeeName','Employee Name'),role:'current'},...(grey[type.behaviour]??[]).map(key=>({key:'current.'+key,label:word('current','Current')+' '+label(key),role:'current' as const}))];
 for(const field of fields)columns.push({key:field,label:field==='incrementAmount'?word('incrementAmount','Increment Amount'):label(field),role:'input',...(field!=='incrementAmount'?{field:field as MovementFormField}:{})});
 if(fields.includes('incrementAmount'))columns.push({key:'calculated.basicSalary',label:word('new','Proposed')+' '+label('basicSalary'),role:'formula'},{key:'calculated.changePercent',label:word('changePercent','Change %'),role:'formula'});
 if(type.behaviour==='salaryAdjustment')columns.push({key:'calculated.difference',label:word('difference','Difference'),role:'formula'});
 for(const field of applicable){if(field==='effectiveDate'||field==='remarks'||fields.includes(field))continue;columns.push({key:field,label:label(field),role:'input',field,other:true});}
 if(type.behaviour!=='blacklist')columns.push({key:'effectiveDate',label:label('effectiveDate'),role:'input',field:'effectiveDate'});
 columns.push({key:'remarks',label:label('remarks'),role:'input',field:'remarks'});
 return columns;
}
export function movementTabNames(types:MovementWorkbookType[],resolve:PersonnelLabelResolver){
 const used=new Set(['instructions','lists','_meta']);return types.map(type=>{
  const base=(type.label??resolve('people.detail.movement.eventType.'+type.behaviour,type.code)).replace(/[\[\]:*?\/\\]/g,' ').replace(/^'+|'+$/g,'').trim()||type.code;
  let name=base.slice(0,31),n=1;while(used.has(name.toLowerCase())){const suffix=' ('+(++n)+')';name=base.slice(0,31-suffix.length)+suffix;}used.add(name.toLowerCase());return name;
 });
}
