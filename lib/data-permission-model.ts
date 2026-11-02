/** Closed employee-data predicate language. SQL owns evaluation; no caller-supplied columns/expressions. */
import {z} from 'zod';
export const DATA_PERMISSION_FIELDS=[
 {id:'company',owner:'employment',field:'companyId',kind:'uuid'},
 {id:'businessUnit',owner:'assignment',field:'businessUnitId',kind:'uuid'},
 {id:'division',owner:'employment',field:'orgDivision',kind:'text'},
 {id:'branch',owner:'employment',field:'orgBranch',kind:'text'},
 {id:'department',owner:'assignment',field:'departmentId',kind:'uuid'},
 {id:'section',owner:'employment',field:'orgSection',kind:'text'},
 {id:'team',owner:'employment',field:'orgTeam',kind:'text'},
 {id:'position',owner:'assignment',field:'positionId',kind:'uuid'},
 {id:'grade',owner:'employment',field:'gradeId',kind:'uuid'},
 {id:'employmentType',owner:'assignment',field:'employmentType',kind:'text'},
 {id:'employmentStatus',owner:'employmentStatus',field:'status',kind:'text'},
 {id:'costCentre',owner:'assignment',field:'costCenterId',kind:'uuid'},
 {id:'nationality',owner:'person',field:'nationality',kind:'text'},
 {id:'gender',owner:'person',field:'gender',kind:'text'},
 {id:'maritalStatus',owner:'person',field:'maritalStatus',kind:'text'},
 {id:'category',owner:'employment',field:'employmentCategory',kind:'text'},
 {id:'employeeId',owner:'employment',field:'employeeCode',kind:'text'},
] as const;
export type DataPermissionField=typeof DATA_PERMISSION_FIELDS[number]['id'];
const fieldIds=DATA_PERMISSION_FIELDS.map(field=>field.id) as [DataPermissionField,...DataPermissionField[]];
const value=z.string().min(1).max(255).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value));
const predicate=z.object({field:z.enum(fieldIds),values:z.array(value).min(1).max(100)}).strict().superRefine((rule,ctx)=>{
 if(new Set(rule.values).size!==rule.values.length)ctx.addIssue({code:'custom',message:'duplicate'});
 if(DATA_PERMISSION_FIELDS.find(field=>field.id===rule.field)?.kind==='uuid'&&rule.values.some(value=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)))ctx.addIssue({code:'custom',message:'invalid reference'});
});
export const dataPermissionRulesSchema=z.object({legacyCompany:z.boolean(),predicates:z.array(predicate).max(17)}).strict().superRefine((rules,ctx)=>{
 if(rules.legacyCompany?rules.predicates.length!==0:rules.predicates.length===0)ctx.addIssue({code:'custom',message:'explicit scope required'});
 if(new Set(rules.predicates.map(row=>row.field)).size!==rules.predicates.length)ctx.addIssue({code:'custom',message:'duplicate field'});
});
export type DataPermissionRules=z.infer<typeof dataPermissionRulesSchema>;
export function canonicalDataPermissionRules(value:unknown):DataPermissionRules{
 const parsed=dataPermissionRulesSchema.safeParse(value);if(!parsed.success)throw new Error('invalid');
 return {...parsed.data,predicates:parsed.data.predicates.map(row=>({...row,values:[...row.values].sort()})).sort((a,b)=>a.field.localeCompare(b.field))};
}
