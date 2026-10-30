/** Workbook presentation only. Applicable inputs remain owned by the canonical New Event contract. */
import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {movementImportRequired} from './movement-import-contract';
import {movementFormFields,MOVEMENT_FORM_IDS,type MovementFormField} from './movement-form-contract';
import {personnelFormField} from './personnel-form-contract';
import {TERMINATION_REASON_CODES} from '../core/termination-reason';
import type {MovementFieldRule} from './movement-field-rules';
import {personnelFieldLabel,personnelFieldChoices,type PersonnelLabelResolver} from './personnel-import-contract';
/** 1d58019a Step 2 — a type also carries its CONTROLS (core/movement-type.ts activeMovementEventTypeChoicesTx):
 * a Termination type the reasons it effectively offers, a comparison type its Field Controls when it has any.
 * The workbook is signed to this list, so a changed reason or rule changes the catalogue fingerprint. */
export type MovementWorkbookReason={code:string;label:string|null;category:string;builtIn:boolean};
export type MovementWorkbookType={code:string;label:string|null;behaviour:string;reasons?:MovementWorkbookReason[];rules?:MovementFieldRule[]};
export type MovementWorkbookColumn={key:string;label:string;role:'identity'|'current'|'input'|'formula';field?:MovementFormField;other?:boolean};
const main:Record<string,string[]>={increment:['incrementAmount'],salaryAdjustment:['basicSalary'],promotion:['positionId','gradeId','incrementAmount','managerEmploymentId'],demotion:['positionId','gradeId','basicSalary'],confirmation:['incrementAmount'],probationExtension:['endDate'],actingPosition:['endDate'],secondment:['endDate'],transfer:['businessUnitId','departmentId','locationId','managerEmploymentId'],orgAssignmentChange:['businessUnitId','departmentId','positionId','locationId'],entityTransfer:['companyId','businessUnitId','departmentId','positionId','locationId','managerEmploymentId'],employmentTypeChange:['employmentType'],reportingLineChange:['managerEmploymentId'],resignation:['tenderResignationDate','resignationEffectiveDate','endDate'],termination:['terminationReasonCode','resignationDate','terminationNoticeDays','endDate'],blacklist:['blacklisted'],joinDateChange:[],groupJoinDateCorrection:[]};
const grey:Record<string,string[]>={increment:['departmentId','gradeId','basicSalary','currency'],salaryAdjustment:['basicSalary','currency'],promotion:['positionId','gradeId','basicSalary','currency','managerEmploymentId'],demotion:['positionId','gradeId','basicSalary','currency'],confirmation:['joinDate','probationEndDate','basicSalary','currency'],probationExtension:['joinDate','probationEndDate'],actingPosition:['positionId'],secondment:['departmentId','locationId'],transfer:['businessUnitId','departmentId','locationId','managerEmploymentId'],orgAssignmentChange:['businessUnitId','departmentId','positionId','locationId'],entityTransfer:['companyId','departmentId','positionId','managerEmploymentId'],employmentTypeChange:['employmentType'],reportingLineChange:['managerEmploymentId'],resignation:['joinDate'],termination:['joinDate'],blacklist:['blacklistedAt'],joinDateChange:['joinDate'],groupJoinDateCorrection:['hiredOn']};
export function movementWorkbookLayout(type:MovementWorkbookType,resolve:PersonnelLabelResolver):MovementWorkbookColumn[]{
 const word=(key:string,fallback:string)=>resolve('people.import.movement.v2.'+key,fallback);
 const label=(field:string)=>field in MOVEMENT_FORM_IDS?personnelFieldLabel(personnelFormField(MOVEMENT_FORM_IDS[field as MovementFormField]),resolve):(()=>{const descriptor=PERSONNEL_FIELDS.find(f=>f.owner==='employment'&&f.ownerField===field&&f.grain==='single');return descriptor?personnelFieldLabel(descriptor,resolve):field==='probationEndDate'?word('probationEndDate','Probation End Date'):field;})();
 const applicable=movementFormFields(type.behaviour,'resignation').filter(f=>f!=='kind');
 const fields=(main[type.behaviour]??['endDate']).filter(f=>f==='incrementAmount'||applicable.some(field=>field===f));
 const columns:MovementWorkbookColumn[]=[{key:'employeeCode',label:resolve('people.import.movement.employeeId','Employee ID'),role:'identity'},{key:'employeeName',label:word('employeeName','Employee Name'),role:'current'},...(grey[type.behaviour]??[]).map(key=>({key:'current.'+key,label:word('current','Current')+' '+label(key),role:'current' as const}))];
 for(const field of fields)columns.push({key:field,label:field==='incrementAmount'?word('incrementAmount','Increment Amount'):label(field),role:'input',...(field!=='incrementAmount'?{field:field as MovementFormField}:{})});
 if(fields.includes('incrementAmount'))columns.push({key:'calculated.basicSalary',label:word('new','Proposed')+' '+label('basicSalary'),role:'formula'},{key:'calculated.changePercent',label:word('changePercent','Change %'),role:'formula'});
 if(type.behaviour==='salaryAdjustment')columns.push({key:'calculated.difference',label:word('difference','Difference'),role:'formula'});
 for(const field of applicable){if(field==='effectiveDate'||field==='remarks'||fields.includes(field))continue;columns.push({key:field,label:label(field),role:'input',field,other:true});}
 if(type.behaviour!=='blacklist')columns.push({key:'effectiveDate',label:label('effectiveDate'),role:'input',field:'effectiveDate'});
 columns.push({key:'remarks',label:label('remarks'),role:'input',field:'remarks'});
 return columns;
}
export function movementTabNames(types:MovementWorkbookType[],resolve:PersonnelLabelResolver){
 const used=new Set(['instructions','reference','lists','_meta']);return types.map(type=>{
  const base=(type.label??resolve('people.detail.movement.eventType.'+type.behaviour,type.code)).replace(/[\[\]:*?\/\\]/g,' ').replace(/^'+|'+$/g,'').trim()||type.code;
  let name=base.slice(0,31),n=1;while(used.has(name.toLowerCase())){const suffix=' ('+(++n)+')';name=base.slice(0,31-suffix.length)+suffix;}used.add(name.toLowerCase());return name;
 });
}

/** Guidance consumes canonical requiredness, adding only approved spreadsheet-purpose input rules. */
export function movementWorkbookRequirements(type:MovementWorkbookType,columns:MovementWorkbookColumn[]){
 const required=columns.filter(c=>c.role==='identity'||c.role==='input'&&(c.key==='incrementAmount'&&type.behaviour==='increment'||c.field&&movementImportRequired(c.field,type.behaviour)||c.field==='basicSalary'&&type.behaviour==='salaryAdjustment'||c.field==='remarks'&&['salaryAdjustment','demotion','joinDateChange','groupJoinDateCorrection'].includes(type.behaviour))).map(c=>c.label);
 const optional=columns.filter(c=>c.role==='input'&&!required.includes(c.label)).map(c=>c.label);
 const requiredEither=type.behaviour==='blacklist'?columns.filter(c=>c.role==='input'&&['blacklisted','remarks'].includes(c.key)).map(c=>c.label):[];
 return {required,optional,requiredEither};
}

/** `label` (when present) is the organisation's own name for the value and wins over `labelKey`. */
export type MovementWorkbookChoice={value:string;labelKey:string;label?:string};
/**
 * 1d58019a Step 2 — termination reasons come from the TENANT's catalogue when the types carry it: the reasons
 * any of the given Termination types offers, in catalogue order, under the organisation's own names. Without
 * reasons on the types (a caller that has none), the built-in list as before.
 */
export function movementWorkbookScalarChoices(field:MovementFormField,types?:readonly MovementWorkbookType[]):readonly MovementWorkbookChoice[]{
 if(field!=='terminationReasonCode')return personnelFieldChoices(personnelFormField(MOVEMENT_FORM_IDS[field]));
 const tenant=(types??[]).filter(type=>type.behaviour==='termination'&&type.reasons);
 if(!tenant.length)return TERMINATION_REASON_CODES.map(value=>({value,labelKey:'people.detail.movement.terminationReason.'+value}));
 const seen=new Map<string,MovementWorkbookChoice>();
 for(const type of tenant)for(const reason of type.reasons!)if(!seen.has(reason.code))seen.set(reason.code,{value:reason.code,labelKey:'people.detail.movement.terminationReason.'+reason.code,...(reason.label?{label:reason.label}:!reason.builtIn?{label:reason.code}:{})});
 return [...seen.values()];
}
/** The text a choice shows: the organisation's own name, else the shipped translation. */
export const movementWorkbookChoiceLabel=(choice:MovementWorkbookChoice,resolve:PersonnelLabelResolver)=>choice.label??resolve(choice.labelKey,choice.value);
