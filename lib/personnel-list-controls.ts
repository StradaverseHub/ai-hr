/** Closed Personnel-list vocabulary. Raw text travels by POST into short-lived private membership. */
import {isCalendarDate} from './calendar-date';
import {EMPLOYEE_COLUMN_KEYS,type EmployeeColumnKey} from './employee-columns';
export type PersonnelColumnFilter={field:string;operator:'contains'|'equals'|'blank'|'notBlank'|'from'|'to';value:string};
const columnSources:Record<EmployeeColumnKey,string>={code:'employeeCode',name:'name',company:'company',department:'department',position:'position',status:'status',jobGrade:'jobGrade',employmentType:'employmentType',reportingTo:'reportingTo',businessUnit:'businessUnit',costCenter:'costCenter',workLocation:'workLocation',groupJoinDate:'hiredOn',joinDate:'joinDate',confirmationDate:'confirmationDate',email:'email'};
export const PERSONNEL_EMPLOYMENT_FILTER_KEYS=['directSuperiorEmployeeCode','directSuperiorFullName','orgDivision','orgBranch','orgRegion','orgLine','orgSection','orgTeam','orgBase','employmentCategory','hiredOn','joinDate','groupService','companyService','yearOfService','probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','finalConfirmationDate','contractStartDate','contractEndDate','contractRemark','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit','tenderResignationDate','resignationDate','lastWorkingDate','confirmationDate'] as const;

export const PERSONNEL_COLUMN_SOURCES=columnSources;
export const PERSONNEL_DATE_COLUMNS=new Set<EmployeeColumnKey>(['groupJoinDate','joinDate','confirmationDate']);
const specs=new Map<string,{type:string}>([...EMPLOYEE_COLUMN_KEYS.map(key=>[key,{type:PERSONNEL_DATE_COLUMNS.has(key)?'date':'text'}] as const),...PERSONNEL_EMPLOYMENT_FILTER_KEYS.map(key=>['employment.'+key,{type:key.endsWith('Value')?'number':key.endsWith('Date')||key==='hiredOn'?'date':'text'}] as const),['identity',{type:'text'}] as const]);
export function parsePersonnelColumnFilters(form:URLSearchParams):PersonnelColumnFilter[]{
 const result:PersonnelColumnFilter[]=[];
 for(const [name,raw]of form){if(!name.startsWith('field.'))continue;const field=name.slice(6),spec=specs.get(field);if(!spec)throw new Error('Unknown Personnel filter.');const value=raw.trim();const requestedOp=form.get('operator.'+field);if(!value&&!['blank','notBlank'].includes(requestedOp??''))continue;if(value.length>200)throw new Error('Filter is too long.');const op=form.get('operator.'+field)??(spec.type==='date'||spec.type==='number'?'equals':'contains');if(!['contains','equals','blank','notBlank','from','to'].includes(op))throw new Error('Unknown Personnel filter operation.');if(!['blank','notBlank'].includes(op)){if(op==='contains'&&['date','number'].includes(spec.type))throw new Error('Choose a typed filter operation.');if(spec.type==='date'&&!isCalendarDate(value))throw new Error('Choose a valid date.');if(spec.type==='number'&&!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value))throw new Error('Enter a valid number.');if((op==='from'||op==='to')&&!['date','number'].includes(spec.type))throw new Error('Range is unavailable for this field.');}const operator=(value==='__blank'&&['company','department','position','businessUnit','jobGrade','status','employmentType'].includes(field)?'blank':op) as PersonnelColumnFilter['operator'];result.push({field,operator,value:operator==='blank'||operator==='notBlank'?'':value});}
 if(result.length>80)throw new Error('Too many Personnel filters.');return result;
}
export function matchesPersonnelColumnFilters(row:Record<string,unknown>,filters:readonly PersonnelColumnFilter[]):boolean{
 return filters.every(filter=>{const spec=specs.get(filter.field);if(!spec)return false;const choices:Record<string,string>={company:'companyId',department:'departmentId',position:'positionId',businessUnit:'businessUnitId'};const source=filter.field.startsWith('employment.')?filter.field.slice(11):choices[filter.field]&&/^[0-9a-f-]{36}$/i.test(filter.value)?choices[filter.field]:columnSources[filter.field as EmployeeColumnKey];const raw=row[source];if(filter.field.startsWith('employment.')&&row.employmentFieldsPermitted!==true)return false;const blank=raw==null||raw==='';if(filter.operator==='blank')return blank;if(filter.operator==='notBlank')return !blank;if(blank)return false;const text=String(raw).toLocaleLowerCase(),needle=filter.value.toLocaleLowerCase();if(spec.type==='number'){const actual=Number(raw),expected=Number(filter.value);return Number.isFinite(actual)&&Number.isFinite(expected)&&(filter.operator==='from'?actual>=expected:filter.operator==='to'?actual<=expected:actual===expected);}return filter.operator==='contains'?text.includes(needle):filter.operator==='from'?text>=needle:filter.operator==='to'?text<=needle:text===needle;});
}

export type PersonnelPrivateCriteria={term:string;filters:PersonnelColumnFilter[]};
/** Revalidate persisted criteria at the presentation/service boundary; never trust JSON as a field selector. */
export function normalizePersonnelPrivateCriteria(raw:unknown):PersonnelPrivateCriteria{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Private filters unavailable.');
 const value=raw as {term?:unknown;filters?:unknown};if(typeof value.term!=='string'||value.term.length>200||!Array.isArray(value.filters)||value.filters.length>80)throw new Error('Private filters unavailable.');
 const form=new URLSearchParams();const seen=new Set<string>();
 for(const rawFilter of value.filters){if(!rawFilter||typeof rawFilter!=='object'||Array.isArray(rawFilter))throw new Error('Private filters unavailable.');const f=rawFilter as Record<string,unknown>;if(typeof f.field!=='string'||typeof f.operator!=='string'||typeof f.value!=='string'||seen.has(f.field))throw new Error('Private filters unavailable.');seen.add(f.field);form.set('field.'+f.field,f.value);form.set('operator.'+f.field,f.operator);}
 return {term:value.term.trim(),filters:parsePersonnelColumnFilters(form)};
}

/**
 * aa045103 — the header filters of the Personnel list write the ORDINARY params the Filter dialog already
 * owns (one owner per fact), never a second multi-value mechanism inside the private criteria.
 * Choice columns: any of the ticked values (comma list), `__blank` for "Blank / unassigned" where a field
 * can be empty. Date columns: an inclusive From/To pair.
 */
export const PERSONNEL_BLANK_VALUE='__blank';
export const PERSONNEL_CHOICE_COLUMN_PARAMS={company:'companies',businessUnit:'bu',department:'dept',position:'position',jobGrade:'grade',status:'bucket',employmentType:'type'} as const satisfies Partial<Record<EmployeeColumnKey,string>>;
export const PERSONNEL_BLANKABLE_CHOICE_PARAMS:readonly string[]=['bu','dept','position','grade','type'];
export const PERSONNEL_DATE_COLUMN_PARAMS={joinDate:['joinedFrom','joinedTo'],groupJoinDate:['hiredFrom','hiredTo'],confirmationDate:['confirmedFrom','confirmedTo']} as const satisfies Partial<Record<EmployeeColumnKey,readonly [string,string]>>;
export type PersonnelChoiceColumn=keyof typeof PERSONNEL_CHOICE_COLUMN_PARAMS;
export type PersonnelDateColumn=keyof typeof PERSONNEL_DATE_COLUMN_PARAMS;
export const isPersonnelChoiceColumn=(key:string):key is PersonnelChoiceColumn=>Object.hasOwn(PERSONNEL_CHOICE_COLUMN_PARAMS,key);
export const isPersonnelDateColumn=(key:string):key is PersonnelDateColumn=>Object.hasOwn(PERSONNEL_DATE_COLUMN_PARAMS,key);

/** The listing URL after one header filter changes: every other ordinary param kept, `page` dropped (a new
 *  narrowing starts on page one), the page size kept. Empty values remove the param. */
export function personnelFilterHref(parameters:readonly (readonly [string,string])[],changes:Record<string,readonly string[]>,pageSize?:string):string{
 const next=new URLSearchParams();
 for(const [key,value] of parameters)if(key!=='page'&&key!=='size'&&!Object.hasOwn(changes,key))next.append(key,value);
 for(const [key,values] of Object.entries(changes)){const kept=[...new Set(values.map(value=>value.trim()).filter(Boolean))];if(kept.length)next.set(key,kept.join(','));}
 if(pageSize)next.set('size',pageSize);
 return '/admin/personnel'+(next.size?'?'+next.toString():'');
}
