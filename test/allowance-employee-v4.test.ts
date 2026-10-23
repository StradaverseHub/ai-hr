import { describe, expect, it } from 'vitest';
import { allowanceEmployeeExpressionMatches, validateAllowanceEmployeeExpression, type AllowanceEmployeeGroup, type AllowanceEmployeeFactsV4 } from '../lib/allowance-employee-expression';
import { allowanceEmployeeMatches, emptyAllowanceRulesV3, upgradeAllowanceEmployeeRules, validateAllowanceRules, type AllowanceRulesV3 } from '../lib/attendance-allowance-rules';
const design='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const materials='20000000-0000-4000-8000-000000000001',group='20000000-0000-4000-8000-000000000002',outside='20000000-0000-4000-8000-000000000003';
const facts=(departmentId:string|null,businessUnitId:string|null):AllowanceEmployeeFactsV4=>({companyId:null,departmentId,businessUnitId,positionId:null,gradeId:null,employmentType:'full_time',employmentCategory:null,status:'active'});
const nested:AllowanceEmployeeGroup={id:'root',type:'group',logic:'and',children:[{id:'design',type:'criterion',field:'departmentId',operator:'is',values:[design]},{id:'business',type:'group',logic:'or',children:[{id:'materials',type:'criterion',field:'businessUnitId',operator:'is',values:[materials]},{id:'group',type:'criterion',field:'businessUnitId',operator:'is',values:[group]}]}]};
describe('grouped employee inclusion preserves the exact Design/two-business-unit rule',()=>{
  it.each([[design,materials,true],[design,group,true],[design,outside,false],[other,materials,false],[other,group,false],[null,materials,false],[design,null,false]])('department %s business unit %s → %s',(department,unit,expected)=>{
    expect(allowanceEmployeeExpressionMatches(validateAllowanceEmployeeExpression(nested),facts(department as string|null,unit as string|null))).toBe(expected);
  });
  it.each(['is','isNot','in','notIn'] as const)('missing data cannot pass %s',operator=>{
    const rule:AllowanceEmployeeGroup={id:'root',type:'group',logic:'and',children:[{id:'condition',type:'criterion',field:'departmentId',operator,values:[design]}]};
    expect(allowanceEmployeeExpressionMatches(validateAllowanceEmployeeExpression(rule),facts(null,materials))).toBe(false);
  });
  it('explicitly upgrading a flat OR keeps every prior match and the attendance expression',()=>{
    const original:AllowanceRulesV3={...emptyAllowanceRulesV3(),employee:{mode:'criteria',employmentIds:[],logic:'or',criteria:[{field:'departmentId',operator:'in',values:[design]},{field:'businessUnitId',operator:'notIn',values:[outside]}]}};
    const originalBytes=JSON.stringify(original),upgraded=validateAllowanceRules(upgradeAllowanceEmployeeRules(original));
    for(const department of [design,other,null])for(const unit of [materials,outside,null])expect(allowanceEmployeeMatches(upgraded.employee,'unused',facts(department,unit))).toBe(allowanceEmployeeMatches(original.employee,'unused',facts(department,unit)));
    expect(upgraded.attendance).toEqual(original.attendance);expect(JSON.stringify(original)).toBe(originalBytes);expect(original.v).toBe(3);
  });
  it('refuses empty groups, unknown keys, invalid fields, duplicate IDs and excessive trees',()=>{
    for(const value of [{...nested,children:[]},{...nested,unknown:true},{...nested,children:[{id:'x',type:'criterion',field:'salary',operator:'in',values:['1']}]},{...nested,children:[nested.children[0],nested.children[0]]},{...nested,children:Array.from({length:31},(_,i)=>({id:`leaf-${i}`,type:'criterion',field:'status',operator:'is',values:['active']}))}])expect(()=>validateAllowanceEmployeeExpression(value)).toThrow();
    let deep:unknown={id:'last',type:'criterion',field:'status',operator:'is',values:['active']};
    for(let i=0;i<8;i++)deep={id:`depth-${i}`,type:'group',logic:'and',children:[deep]};
    expect(()=>validateAllowanceEmployeeExpression(deep)).toThrow();
  });
  it('requires exactly one Is/Is Not value and does not silently collapse duplicate selected employees',()=>{
    expect(()=>validateAllowanceEmployeeExpression({...nested,children:[{id:'one',type:'criterion',field:'departmentId',operator:'isNot',values:[design,other]}]})).toThrow();
    const base=upgradeAllowanceEmployeeRules(emptyAllowanceRulesV3());
    expect(()=>validateAllowanceRules({...base,employee:{...base.employee,mode:'selected',employmentIds:[design,design]}})).toThrow();
    expect(()=>validateAllowanceRules({...base,employee:{...base.employee,mode:'selected',employmentIds:[]}})).toThrow();
    expect(()=>validateAllowanceRules({...base,employee:{...base.employee,mode:'criteria',expression:{id:'empty',type:'group',logic:'or',children:[]}}})).toThrow();
  });
});

it('editor preview and period calculation use the same final owned employment day',async()=>{
 const {allowanceEmployeePeriodMatch}=await import('../lib/attendance-allowance-rules');
 const rule=upgradeAllowanceEmployeeRules({...emptyAllowanceRulesV3(),employee:{mode:'criteria',employmentIds:[],logic:'and',criteria:[{field:'departmentId',operator:'in',values:[design]}]}}).employee;
 const input={days:[{date:'2026-01-05'},{date:'2026-01-04'}],factsByDate:new Map([['2026-01-04',facts(other,materials)],['2026-01-05',facts(design,materials)]])};
 expect(allowanceEmployeePeriodMatch(rule,'own',input,{from:'2026-01-01',to:'2026-01-31'})).toMatchObject({asOf:'2026-01-05',pass:true});
 expect(allowanceEmployeePeriodMatch(rule,'own',input,{from:'2026-01-01',to:'2026-01-04'})).toMatchObject({asOf:'2026-01-04',pass:false});
});
