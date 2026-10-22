import {personnelReportValueKey} from './personnel-report-value';
/** Client-safe Employee Master specification and pure execution over authorised owner projections.
 * The shared Personnel registry owns fields. This engine owns only selection/row grains/presentation.
 */
import { z } from 'zod';
import { todayInKualaLumpur } from './hr-date';
import { isCalendarDate } from './calendar-date';
import type { PersonnelFieldDescriptor } from './personnel-field-registry';

export type MasterScalar = string | number | boolean | null;
export type MasterUnavailableReason = 'historical-unavailable'|'not-recorded'|'not-applicable'|'draft-unfinished'|'unknown-currency'|'mixed-currency'|'incompatible-units';
export type MasterCell = { value:MasterScalar; display?:string; unavailable?:MasterUnavailableReason; currency?:string|null; unit?:string; sourceRecordId?:string; labelIsCurrent?:boolean; recordedKind?:'intent'|'effect'; referenceId?:string|null };
export type MasterOwnerRecord = { id:string; effectiveFrom?:string|null; effectiveTo?:string|null; createdAt?:string|null; values:Record<string,MasterCell>; currency?:string|null };
export type MasterSubject = { id:string; kind:'employment'|'draft'; personId:string|null; companyId:string|null; owners:Record<string,MasterOwnerRecord[]>; scopeUnavailable?:'historical-company-unavailable'; historyScopeUnavailable?:boolean };
export type MasterOperator = 'eq'|'ne'|'contains'|'in'|'between'|'before'|'after'|'blank'|'notBlank';
export type MasterCondition = {id:string;type:'condition';field:string;operator:MasterOperator;value?:MasterScalar;upper?:MasterScalar;values?:MasterScalar[]};
export type MasterExpression = MasterCondition|{id:string;type:'group';logic:'and'|'or';children:MasterExpression[]};
export type MasterColumn = {field:string;header?:string;format:'auto'|'text'|'date'|'number';decimals:number;sum:boolean;freeze:boolean;align:'left'|'center'|'right';width:'auto'|'narrow'|'medium'|'wide';records:'latest'|'all';side?:'before'|'after'};
export type EmployeeMasterSpec = {v:2;asAt:string;companyIds:string[];includeDrafts:boolean;columns:MasterColumn[];expression:MasterExpression;sorts:{field:string;dir:'asc'|'desc'}[];groups:string[];pdf:{paper:'A4'|'A3'|'Letter'|'Legal';orientation:'portrait'|'landscape';margins:'narrow'|'normal'|'wide';logo:boolean;pageBreakGroups:boolean}};
export const MASTER_PREVIEW_ROWS=50;
export const MASTER_EXPORT_MAX_ROWS=50_000;
export const MASTER_EXPORT_MAX_CELLS=2_000_000;
const isoDate=z.string().refine(isCalendarDate,'Enter a valid date.');
const scalar=z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]);
const column=z.object({field:z.string().min(1).max(200),header:z.string().trim().max(120).optional(),format:z.enum(['auto','text','date','number']),decimals:z.number().int().min(0).max(6),sum:z.boolean(),freeze:z.boolean(),align:z.enum(['left','center','right']),width:z.enum(['auto','narrow','medium','wide']),records:z.enum(['latest','all']),side:z.enum(['before','after']).optional()}).strict();
const definition=z.object({v:z.literal(2),asAt:isoDate,companyIds:z.array(z.uuid()).min(1).max(100),includeDrafts:z.boolean(),columns:z.array(column).min(1).max(500),expression:z.unknown(),sorts:z.array(z.object({field:z.string(),dir:z.enum(['asc','desc'])}).strict()).max(3),groups:z.array(z.string()).max(3),pdf:z.object({paper:z.enum(['A4','A3','Letter','Legal']),orientation:z.enum(['portrait','landscape']),margins:z.enum(['narrow','normal','wide']),logo:z.boolean(),pageBreakGroups:z.boolean()}).strict()}).strict();

export class EmployeeMasterSpecError extends Error { override name='EmployeeMasterSpecError'; }
/** Opening a stored definition for repair grants no execution or scheduling authority. */
export function validateEmployeeMasterDefinition(raw:unknown,fields:readonly PersonnelFieldDescriptor[]):EmployeeMasterSpec {
  return validateDefinition(raw,fields);
}
export function validateEmployeeMasterSpec(raw:unknown,fields:readonly PersonnelFieldDescriptor[],today:string):EmployeeMasterSpec {
  return validateDefinition(raw,fields,today);
}
function validateDefinition(raw:unknown,fields:readonly PersonnelFieldDescriptor[],today?:string):EmployeeMasterSpec {
  const parsed=definition.parse(raw);
  if(parsed.pdf.logo&&parsed.companyIds.length!==1)throw new EmployeeMasterSpecError('Choose one company to print its logo.');
  if(today!==undefined&&parsed.asAt>today)throw new EmployeeMasterSpecError('Choose an as-at date on or before today.');
  const byId=new Map(fields.filter(f=>f.report.enabled).map(f=>[f.id,f]));
  // The supplied catalogue must already be permission-scoped. Errors never echo a restricted ID/label.
  const field=(id:string,capability?:'filter'|'sort'|'group'|'sum')=>{
    const f=byId.get(id);if(!f||capability&&!f.report[capability])throw new EmployeeMasterSpecError('A selected report field is unavailable or not permitted for this operation.');return f;
  };
  if(new Set(parsed.columns.map(c=>c.field+':'+(c.side??'after'))).size!==parsed.columns.length)throw new EmployeeMasterSpecError('Select each report field once.');
  for(const c of parsed.columns){const f=field(c.field);if(c.side&&f.owner!=='movementComparison')throw new EmployeeMasterSpecError('Before/After columns apply only to Movement comparisons.');if(c.sum)field(c.field,'sum');if(c.format==='date'&&f.type!=='date'||c.format==='number'&&!['number','currency'].includes(f.type))throw new EmployeeMasterSpecError('Column format does not match its field type.');if(c.records==='all'&&f.grain!=='many')throw new EmployeeMasterSpecError('All records applies only to record registers.');}
  const firstUnfrozen=parsed.columns.findIndex(column=>!column.freeze);if(firstUnfrozen>=0&&parsed.columns.slice(firstUnfrozen).some(column=>column.freeze))throw new EmployeeMasterSpecError('Frozen columns must form a leading block.');
  for(const sort of parsed.sorts)field(sort.field,'sort');
  for(const group of parsed.groups)field(group,'group');
  if(new Set(parsed.groups).size!==parsed.groups.length||new Set(parsed.sorts.map(s=>s.field)).size!==parsed.sorts.length)throw new EmployeeMasterSpecError('Choose distinct group and sort fields.');
  let nodes=0;const ids=new Set<string>();
  const visit=(rawNode:unknown,depth:number):MasterExpression=>{
    if(depth>6||++nodes>200)throw new EmployeeMasterSpecError('Conditions exceed the supported depth or size.');
    const base=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),type:z.enum(['group','condition'])}).passthrough().parse(rawNode);
    if(ids.has(base.id))throw new EmployeeMasterSpecError('Condition identifiers must be distinct.');ids.add(base.id);
    if(base.type==='group'){
      const g=z.object({id:z.string(),type:z.literal('group'),logic:z.enum(['and','or']),children:z.array(z.unknown()).max(30)}).strict().parse(rawNode);
      if(depth>0&&!g.children.length)throw new EmployeeMasterSpecError('Add a condition or remove the empty group.');
      return {...g,children:g.children.map(child=>visit(child,depth+1))};
    }
    const c=z.object({id:z.string(),type:z.literal('condition'),field:z.string(),operator:z.enum(['eq','ne','contains','in','between','before','after','blank','notBlank']),value:scalar.optional(),upper:scalar.optional(),values:z.array(scalar).max(100).optional()}).strict().parse(rawNode);
    const f=field(c.field,'filter');
    if(today!==undefined&&parsed.asAt!==today&&f.history==='current')throw new EmployeeMasterSpecError('A condition uses a current-only field. Choose today or remove that condition.');
    const ordered=f.type==='date'||f.type==='number'||f.type==='currency';
    if(c.operator==='contains'&&!['text','choice','status'].includes(f.type)||['between','before','after'].includes(c.operator)&&!ordered)throw new EmployeeMasterSpecError('The comparison does not match its field type.');
    const operand=(value:MasterScalar|undefined)=>{
      if(value===undefined||value===null)throw new EmployeeMasterSpecError('Enter a complete condition value.');
      if(f.type==='boolean'){if(typeof value!=='boolean')throw new EmployeeMasterSpecError('Choose Yes or No.');}
      else if(f.type==='date')isoDate.parse(f.unit==='month'?String(value)+'-01':value);
      else if(f.type==='number'||f.type==='currency'){if(typeof value!=='number'||!Number.isFinite(value))throw new EmployeeMasterSpecError('Enter a complete number.');}
      else if(typeof value!=='string')throw new EmployeeMasterSpecError('Enter a text or choice value.');
    };
    if(c.operator==='blank'||c.operator==='notBlank'){if(c.value!==undefined||c.upper!==undefined||c.values!==undefined)throw new EmployeeMasterSpecError('Blank conditions take no value.');}
    else if(c.operator==='in'){if(!c.values?.length||c.value!==undefined||c.upper!==undefined)throw new EmployeeMasterSpecError('Choose one or more values.');c.values.forEach(operand);}
    else {operand(c.value);if(c.values!==undefined)throw new EmployeeMasterSpecError('Only In list accepts multiple values.');if(c.operator==='between'){operand(c.upper);if((f.type==='date'?String(c.upper)<String(c.value):Number(c.upper)<Number(c.value)))throw new EmployeeMasterSpecError('The upper bound must not precede the lower bound.');}else if(c.upper!==undefined)throw new EmployeeMasterSpecError('Only Between takes an upper value.');}
    return c;
  };
  const expression=visit(parsed.expression,0);if(expression.type!=='group')throw new EmployeeMasterSpecError('Conditions require an All/Any root group.');
  return {...parsed,companyIds:[...new Set(parsed.companyIds)],expression};
}
export function defaultMasterColumn(field:PersonnelFieldDescriptor):MasterColumn{return {field:field.id,format:'auto',decimals:field.type==='currency'?2:0,sum:false,freeze:false,align:['number','currency'].includes(field.type)?'right':'left',width:'auto',records:'latest'};}
export function masterSpecFields(spec:EmployeeMasterSpec):string[]{
  const conditions=(e:MasterExpression):string[]=>e.type==='condition'?[e.field]:e.children.flatMap(conditions);
  return [...new Set([...spec.columns.map(c=>c.field),...spec.sorts.map(s=>s.field),...spec.groups,...conditions(spec.expression)])];
}
const unavailable=(reason:MasterUnavailableReason):MasterCell=>({value:null,unavailable:reason});
export type MasterOutputRow={subjectId:string;personId:string|null;kind:'employment'|'draft';recordId:string|null;cells:MasterCell[];group:MasterCell[];sourceKeys:string[]};
export type MasterTotal={field:string;side?:'before'|'after';value:string|null;currency:string|null;unit:string|null;unavailable?:MasterUnavailableReason};
export type MasterGroup={key:string;values:MasterCell[];rowCount:number;employeeCount:number;personCount:number;draftCount:number;totals:MasterTotal[]};
export type MasterSection={id:string;grain:string;columns:MasterColumn[];rows:MasterOutputRow[];rowCount:number;employeeCount:number;personCount:number;draftCount:number;groups:MasterGroup[];totals:MasterTotal[]};
export type EmployeeMasterResult={asAt:string;employeeCount:number;personCount:number;draftCount:number;unknownMatchCount:number;unknownScopeCount:number;historyScopeUnavailable:boolean;totalRows:number;sections:MasterSection[]};

/** Every owner row has a stable identity. Dated latest ties use effective date, creation time, then ID. */
export function runEmployeeMasterProjection(spec:EmployeeMasterSpec,fields:readonly PersonnelFieldDescriptor[],subjects:readonly MasterSubject[],today:string):EmployeeMasterResult{
  const byId=new Map(fields.map(f=>[f.id,f]));
  const descriptor=(id:string)=>{const f=byId.get(id);if(!f)throw new Error('Report catalogue changed; review the report again.');return f;};
  // Each invocation consumes one authorised owner snapshot. Expanded rows and Latest columns
  // reuse its date-filtered order; never retain records across report calls or subjects.
  const ownerRecords=new WeakMap<MasterSubject,Map<string,MasterOwnerRecord[]>>();
  const records=(subject:MasterSubject,owner:string)=>{
    let owners=ownerRecords.get(subject);if(!owners){owners=new Map();ownerRecords.set(subject,owners);}
    const cached=owners.get(owner);if(cached)return cached;
    const available=[...(subject.owners[owner]??[])].filter(r=>{const date=r.effectiveFrom??(r.createdAt?todayInKualaLumpur(new Date(r.createdAt)):undefined);return !date||date<=spec.asAt;})
      .sort((a,b)=>(b.effectiveFrom??'').localeCompare(a.effectiveFrom??'')||(b.createdAt??'').localeCompare(a.createdAt??'')||b.id.localeCompare(a.id));
    owners.set(owner,available);return available;
  };
  const cell=(subject:MasterSubject,field:string,expanded?:{owner:string;record:MasterOwnerRecord},side:'before'|'after'='after'):{cell:MasterCell;source:string}=>{
    const f=descriptor(field);
    if(subject.kind==='draft'&&f.scope==='employment'||subject.kind==='employment'&&f.scope==='draft')return {cell:unavailable('not-applicable'),source:subject.id+':'+field};
    if(spec.asAt!==today&&(f.history==='current'||f.history==='none'))return {cell:unavailable('historical-unavailable'),source:subject.id+':'+field};
    // Matching All rows already passed this owner's date filtering and ordering during expansion.
    // Latest overrides and cross-owner cells still resolve their own eligible records below.
    let record:MasterOwnerRecord|undefined;
    if(expanded?.owner===f.owner)record=expanded.record;
    else{
      const available=records(subject,f.owner);
      record=f.grain==='many'?available[0]:available.find(r=>!r.effectiveTo||r.effectiveTo>spec.asAt);
    }
    const value=record?.values[(side==='before'?'before:':'')+personnelReportValueKey(f)]??unavailable(subject.kind==='draft'?'draft-unfinished':'not-recorded');
    return {cell:{...value,currency:value.currency??record?.currency,sourceRecordId:record?.id},source:f.owner+':'+(record?.id??subject.id+':missing')+':'+side+':'+personnelReportValueKey(f)};
  };
  type Truth='true'|'false'|'unknown';
  const matches=(expression:MasterExpression,subject:MasterSubject):Truth=>{
    if(expression.type==='group'){
      const children=expression.children.map(child=>matches(child,subject));
      return !children.length?'true':expression.logic==='and'?children.includes('false')?'false':children.includes('unknown')?'unknown':'true':children.includes('true')?'true':children.includes('unknown')?'unknown':'false';
    }
    const actual=cell(subject,expression.field).cell;if(actual.unavailable)return 'unknown';
    const v=actual.value,comparison=actual.referenceId??(descriptor(expression.field).unit==='instant'&&v!=null?todayInKualaLumpur(new Date(String(v))):v),expected=expression.value;
    const equal=(a:MasterScalar,b:MasterScalar|undefined)=>typeof a==='string'&&typeof b==='number'&&['number','currency'].includes(descriptor(expression.field).type)?Number(a)===b:a===b;
    let pass=false;
    switch(expression.operator){
      case 'blank':pass=comparison==null||comparison==='';break;
      case 'notBlank':pass=comparison!=null&&comparison!=='';break;
      case 'eq':pass=equal(comparison,expected);break;
      case 'ne':pass=!equal(comparison,expected);break;
      case 'contains':pass=v!=null&&String(v).toLocaleLowerCase().includes(String(expected).toLocaleLowerCase());break;
      case 'in':pass=(expression.values??[]).some(value=>equal(comparison,value));break;
      case 'before':case 'after':case 'between':{
        if(v==null)return 'false';
        const numeric=['number','currency'].includes(descriptor(expression.field).type);
        const a=numeric?Number(v):descriptor(expression.field).unit==='instant'?todayInKualaLumpur(new Date(String(v))):String(v),lo=numeric?Number(expected):String(expected),hi=numeric?Number(expression.upper):String(expression.upper);
        pass=expression.operator==='before'?a<lo:expression.operator==='after'?a>lo:a>=lo&&a<=hi;break;
      }
    }
    return pass?'true':'false';
  };
  let unknownMatchCount=0,unknownScopeCount=0;
  if(new Set(subjects.map(subject=>subject.kind+':'+subject.id)).size!==subjects.length)throw new Error('Duplicate report subject identity.');
  const selected=subjects.filter(subject=>{
    if(subject.kind==='draft'&&!spec.includeDrafts||subject.companyId!=null&&!spec.companyIds.includes(subject.companyId))return false;
    if(subject.scopeUnavailable){unknownScopeCount++;return false;}
    const state=matches(spec.expression,subject);if(state==='unknown')unknownMatchCount++;return state==='true';
  });
  const allOwners=[...new Set(spec.columns.filter(c=>c.records==='all').map(c=>descriptor(c.field).owner))];
  const grains=allOwners.length?allOwners:['employment'];
  const totals=(rows:MasterOutputRow[],columns:MasterColumn[]):MasterTotal[]=>columns.flatMap<MasterTotal>((c,i)=>{
    if(!c.sum)return [];
    const f=descriptor(c.field),seen=new Set<string>(),cells:MasterCell[]=[];
    for(const row of rows){if(row.kind==='draft'||seen.has(row.sourceKeys[i]))continue;seen.add(row.sourceKeys[i]);cells.push(row.cells[i]);}
    const currencies=new Set(cells.map(value=>value.currency??'')),units=new Set(cells.map(value=>value.unit??f.unit??''));
    const reason=cells.find(value=>value.unavailable)?.unavailable??(f.type==='currency'&&currencies.has('')?'unknown-currency':f.type==='currency'&&currencies.size>1?'mixed-currency':units.size>1?'incompatible-units':undefined);
    if(reason)return [{field:c.field,side:c.side,value:null,currency:null,unit:f.unit??null,unavailable:reason}];
    // Decimal strings are added in integers; no floating-point salary sum or currency conversion.
    let sum=BigInt(0);const scale=BigInt(1_000_000);
    for(const value of cells){if(value.value==null||value.value==='')continue;const text=String(value.value);if(!/^-?\d+(?:\.\d{1,6})?$/.test(text))return [{field:c.field,side:c.side,value:null,currency:null,unit:f.unit??null,unavailable:'not-recorded' as const}];const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.');sum+=(negative?BigInt(-1):BigInt(1))*(BigInt(whole)*scale+BigInt(fraction.padEnd(6,'0')));}
    const sign=sum<BigInt(0)?'-':'',absolute=sum<BigInt(0)?-sum:sum;
    const value=sign+String(absolute/scale)+'.'+String(absolute%scale).padStart(6,'0');
    return [{field:c.field,side:c.side,value,currency:f.type==='currency'?[...currencies][0]??null:null,unit:f.unit??null}];
  });
  const sections=grains.map(grain=>{
    // Unrelated expanded registers get separate sections; latest overrides remain available in each.
    const columns=spec.columns.filter(c=>c.records!=='all'||descriptor(c.field).owner===grain);
    const rows:MasterOutputRow[]=[];
    for(const subject of selected){
      const expanded=grain==='employment'?[null]:records(subject,grain);
      for(const record of expanded.length?expanded:[null]){
        const context=record?{owner:grain,record}:undefined;
        const values=columns.map(c=>cell(subject,c.field,c.records==='all'?context:undefined,c.side));
        rows.push({subjectId:subject.id,personId:subject.personId,kind:subject.kind,recordId:record?.id??null,cells:values.map(v=>v.cell),sourceKeys:values.map(v=>v.source),group:spec.groups.map(field=>cell(subject,field,context).cell)});
      }
    }
    const sortValue=(row:MasterOutputRow,field:string)=>{const i=columns.findIndex(c=>c.field===field);return i>=0?row.cells[i]:cell(selected.find(subject=>subject.id===row.subjectId)!,field).cell;};
    rows.sort((a,b)=>{
      for(let index=0;index<spec.groups.length;index++){const x=a.group[index],y=b.group[index],order=String(x.referenceId??x.value??'').localeCompare(String(y.referenceId??y.value??''));if(order)return order;}
      for(const sort of spec.sorts){const x=sortValue(a,sort.field),y=sortValue(b,sort.field);let result=0;if(x.unavailable||x.value==null)result=y.unavailable||y.value==null?0:1;else if(y.unavailable||y.value==null)result=-1;else if(['number','currency'].includes(descriptor(sort.field).type))result=Number(x.value)-Number(y.value);else result=String(x.value).localeCompare(String(y.value));if(result)return sort.dir==='desc'?-result:result;}
      return a.subjectId.localeCompare(b.subjectId)||(a.recordId??'').localeCompare(b.recordId??'');
    });
    const grouped=new Map<string,MasterOutputRow[]>();for(const row of rows){const key=JSON.stringify(row.group.map(value=>[value.referenceId??value.value,value.unavailable??null]));const bucket=grouped.get(key)??[];bucket.push(row);grouped.set(key,bucket);}
    const counts=(items:MasterOutputRow[])=>({employeeCount:new Set(items.filter(row=>row.kind==='employment').map(row=>row.subjectId)).size,draftCount:new Set(items.filter(row=>row.kind==='draft').map(row=>row.subjectId)).size});
    const groups=spec.groups.length?[...grouped].map(([key,items])=>({key,values:items[0].group,rowCount:items.length,...counts(items),personCount:new Set(items.flatMap(row=>row.personId?[row.personId]:[])).size,totals:totals(items,columns)})):[];
    return {id:grain,grain,columns,rows,rowCount:rows.length,...counts(rows),personCount:new Set(rows.flatMap(row=>row.personId?[row.personId]:[])).size,groups,totals:totals(rows,columns)};
  });
  const totalRows=sections.reduce((sum,section)=>sum+section.rowCount,0);
  if(totalRows>MASTER_EXPORT_MAX_ROWS||sections.reduce((sum,section)=>sum+section.rowCount*section.columns.length,0)>MASTER_EXPORT_MAX_CELLS)throw new Error('This report is too large. Narrow the company/date/employee conditions or select fewer columns before exporting.');
  return {asAt:spec.asAt,employeeCount:selected.filter(subject=>subject.kind==='employment').length,personCount:new Set(selected.flatMap(subject=>subject.personId?[subject.personId]:[])).size,draftCount:selected.filter(subject=>subject.kind==='draft').length,unknownMatchCount,unknownScopeCount,historyScopeUnavailable:subjects.some(subject=>!!subject.historyScopeUnavailable&&subject.companyId!=null&&spec.companyIds.includes(subject.companyId)),totalRows,sections};
}
