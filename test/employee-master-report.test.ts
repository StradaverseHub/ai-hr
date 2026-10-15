import { describe, expect, it } from 'vitest';
import { PERSONNEL_FIELDS, type PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import { defaultMasterColumn, runEmployeeMasterProjection, validateEmployeeMasterSpec, type EmployeeMasterSpec, type MasterSubject, type MasterOwnerRecord } from '../lib/employee-master-report';

const today='2026-10-15',company='11111111-1111-4111-8111-111111111111';
const f=(id:string,owner:string,over:Partial<PersonnelFieldDescriptor>={}):PersonnelFieldDescriptor=>({id,labelKey:'',label:id,tab:'Test',section:'Test',type:'text',owner,ownerField:id,grain:owner==='person'?'single':'many',history:'dated',sensitivity:'personnel',scope:'both',report:{enabled:true,filter:true,sort:true,group:true,sum:false},import:{requiredCreate:false,requiredUpdate:false,order:0},...over});
const fields=[f('name','person'),f('salary','compensation',{type:'currency',report:{enabled:true,filter:true,sort:true,group:false,sum:true}}),f('child','dependent'),f('document','document'),f('current','person',{history:'current'}),f('number','person',{type:'number'})];
const definition=(over:Partial<EmployeeMasterSpec>={}):EmployeeMasterSpec=>({v:2,asAt:today,companyIds:[company],includeDrafts:false,columns:[defaultMasterColumn(fields[0])],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false},...over});
const record=(id:string,values:MasterOwnerRecord['values'],over:Partial<MasterOwnerRecord>={}):MasterOwnerRecord=>({id,effectiveFrom:'2020-01-01',values,...over});
const subject=(id:string,over:Partial<MasterSubject>={}):MasterSubject=>({id,kind:'employment',personId:id,companyId:company,owners:{person:[record('person-'+id,{name:{value:'Employee '+id},number:{value:1},current:{value:'Current name'}})],compensation:[record('salary-'+id,{salary:{value:'1000.10',currency:'MYR'}})],dependent:[record('child-'+id+'-1',{child:{value:'Older'}}),record('child-'+id+'-2',{child:{value:'Newer'}},{effectiveFrom:'2021-01-01'})],document:[record('doc-'+id+'-1',{document:{value:'A'}}),record('doc-'+id+'-2',{document:{value:'B'}})]},...over});
const validate=(spec:EmployeeMasterSpec,catalogue=fields)=>validateEmployeeMasterSpec(spec,catalogue,today);

describe('Employee Master report contract',()=>{
  it('declares all approved tab entries once with stable unique IDs and explicit disabled control reasons',()=>{
    expect(PERSONNEL_FIELDS).toHaveLength(385);
    expect(new Set(PERSONNEL_FIELDS.map(field=>field.id)).size).toBe(385);
    expect(new Set(PERSONNEL_FIELDS.map(field=>field.tab)).size).toBe(11);
    expect(PERSONNEL_FIELDS.filter(field=>!field.report.enabled).every(field=>!!field.report.disabledReason)).toBe(true);
    expect(PERSONNEL_FIELDS.filter(field=>field.scope==='draft')).toHaveLength(5);
  });
  it('excludes historical-scope unknowns from rows/totals and counts only subjects already within the selected scope',()=>{
    const selected=subject('missing',{scopeUnavailable:'historical-company-unavailable'}),foreign=subject('foreign',{companyId:'22222222-2222-4222-8222-222222222222',scopeUnavailable:'historical-company-unavailable'});
    expect(runEmployeeMasterProjection(definition(),fields,[selected,foreign],today)).toMatchObject({employeeCount:0,personCount:0,totalRows:0,unknownScopeCount:1,unknownMatchCount:0});
  });
  it('refuses hidden fields in columns, conditions, sorts and groups without echoing their identity',()=>{
    const permitted=fields.filter(field=>field.id!=='salary');
    const attempts=[definition({columns:[defaultMasterColumn(fields[1])]}),definition({sorts:[{field:'salary',dir:'asc'}]}),definition({groups:['salary']}),definition({expression:{id:'root',type:'group',logic:'and',children:[{id:'hidden',type:'condition',field:'salary',operator:'eq',value:1000}]}})];
    for(const attempt of attempts){expect(()=>validate(attempt,permitted)).toThrow('A selected report field is unavailable or not permitted');}
  });
  it('validates true dates, complete typed operands, distinct sorts and unsupported formats',()=>{
    expect(()=>validate(definition({asAt:'2026-02-31'}))).toThrow();
    expect(()=>validate(definition({sorts:Array.from({length:4},()=>({field:'name',dir:'asc' as const}))}))).toThrow();
    expect(()=>validate(definition({columns:[{...defaultMasterColumn(fields[0]),format:'number'}]}))).toThrow('Column format');
    expect(()=>validate(definition({expression:{id:'r',type:'group',logic:'and',children:[{id:'c',type:'condition',field:'number',operator:'eq',value:'1'}]}}))).toThrow('complete number');
  });
  it('requires explicit historical availability for conditions but shows unavailable selected values',()=>{
    expect(()=>validate(definition({asAt:'2025-01-01',expression:{id:'r',type:'group',logic:'and',children:[{id:'c',type:'condition',field:'current',operator:'eq',value:'Current name'}]}}))).toThrow('current-only');
    const result=runEmployeeMasterProjection(validate(definition({asAt:'2025-01-01',columns:[defaultMasterColumn(fields[4])]})),fields,[subject('one')],today);
    expect(result.sections[0].rows[0].cells[0]).toMatchObject({value:null,unavailable:'historical-unavailable'});
  });
  it('keeps Unknown distinct from blank and applies nested All/Any truth consistently',()=>{
    const value=subject('one');value.owners.person[0].values.name={value:null,unavailable:'not-recorded'};
    const condition={id:'unknown',type:'condition' as const,field:'name',operator:'blank' as const};
    const spec=validate(definition({expression:{id:'r',type:'group',logic:'or',children:[condition,{id:'known',type:'condition',field:'number',operator:'eq',value:1}]}}));
    expect(runEmployeeMasterProjection(spec,fields,[value],today)).toMatchObject({employeeCount:1,unknownMatchCount:0});
    spec.expression={id:'r',type:'group',logic:'and',children:[condition]};
    expect(runEmployeeMasterProjection(spec,fields,[value],today)).toMatchObject({employeeCount:0,unknownMatchCount:1});
  });
  it('separates unrelated All registers and does not multiply salary or employee totals',()=>{
    const spec=validate(definition({columns:[defaultMasterColumn(fields[0]),{...defaultMasterColumn(fields[1]),sum:true},{...defaultMasterColumn(fields[2]),records:'all'},{...defaultMasterColumn(fields[3]),records:'all'}]}));
    const result=runEmployeeMasterProjection(spec,fields,[subject('one'),subject('two')],today);
    expect(result).toMatchObject({employeeCount:2,personCount:2,totalRows:8});
    expect(result.sections.map(section=>[section.grain,section.rowCount,section.employeeCount])).toEqual([['dependent',4,2],['document',4,2]]);
    for(const section of result.sections)expect(section.totals).toEqual([{field:'salary',value:'2000.200000',currency:'MYR',unit:null}]);
  });
  it('aligns same-register columns to one record and retains a latest override independently',()=>{
    const childId=f('childId','dependent');const catalogue=[...fields,childId];
    const value=subject('one');for(const r of value.owners.dependent)r.values.childId={value:r.id};
    const spec=validate(definition({columns:[{...defaultMasterColumn(fields[2]),records:'all'},defaultMasterColumn(childId)]}),catalogue);
    const rows=runEmployeeMasterProjection(spec,catalogue,[value],today).sections[0].rows;
    expect(rows.map(row=>row.cells.map(cell=>cell.value))).toEqual([['Older','child-one-2'],['Newer','child-one-2']]);
    spec.columns[1].records='all';
    expect(runEmployeeMasterProjection(spec,catalogue,[value],today).sections[0].rows.map(row=>row.cells.map(cell=>cell.value)))
      .toEqual([['Older','child-one-1'],['Newer','child-one-2']]);
  });
  it('retains subjects whose selected All register has no record',()=>{
    const value=subject('one');value.owners.dependent=[];
    const spec=validate(definition({columns:[{...defaultMasterColumn(fields[2]),records:'all'}]}));
    expect(runEmployeeMasterProjection(spec,fields,[value],today).sections[0]).toMatchObject({rowCount:1,employeeCount:1,rows:[{cells:[{value:null,unavailable:'not-recorded'}]}]});
  });
  it('refuses mixed/unknown currency totals instead of summing incompatible salaries',()=>{
    const a=subject('a'),b=subject('b');b.owners.compensation[0].values.salary.currency='USD';
    const spec=validate(definition({columns:[{...defaultMasterColumn(fields[1]),sum:true}]}));
    expect(runEmployeeMasterProjection(spec,fields,[a,b],today).sections[0].totals[0]).toMatchObject({value:null,unavailable:'mixed-currency'});
    b.owners.compensation[0].values.salary.currency=null;
    expect(runEmployeeMasterProjection(spec,fields,[a,b],today).sections[0].totals[0]).toMatchObject({value:null,unavailable:'unknown-currency'});
  });
  it('uses distinct person counts and keeps drafts outside active salary sums',()=>{
    const a=subject('a',{personId:'same-person'}),b=subject('b',{personId:'same-person'}),draft=subject('draft',{kind:'draft',personId:null});
    const spec=validate(definition({includeDrafts:true,columns:[{...defaultMasterColumn(fields[1]),sum:true}]}));
    const result=runEmployeeMasterProjection(spec,fields,[a,b,draft],today);
    expect(result).toMatchObject({employeeCount:2,personCount:1,draftCount:1});
    expect(result.sections[0].totals[0].value).toBe('2000.200000');
  });
  it('retains all rows for export and provides a complete count beyond the preview limit',()=>{
    const result=runEmployeeMasterProjection(validate(definition()),fields,Array.from({length:60},(_,i)=>subject(String(i))),today);
    expect(result.totalRows).toBe(60);expect(result.sections[0].rows).toHaveLength(60);
  });
  it('excludes future effective revisions and breaks equal-date latest ties deterministically',()=>{
    const value=subject('one');value.owners.compensation.push(record('later',{salary:{value:'999.00',currency:'MYR'}},{effectiveFrom:'2027-01-01'}));
    value.owners.compensation.push(record('salary-one-z',{salary:{value:'1200.00',currency:'MYR'}}));
    const spec=validate(definition({columns:[defaultMasterColumn(fields[1])]}));
    expect(runEmployeeMasterProjection(spec,fields,[value],today).sections[0].rows[0].cells[0].value).toBe('1200.00');
  });
});
