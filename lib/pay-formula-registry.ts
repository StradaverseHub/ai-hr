/** The closed, typed variable vocabulary shared by both formula editors and authorized providers. */
export type FormulaType = 'decimal' | 'string' | 'boolean' | 'date';
export type FormulaValue = {type:'decimal';value:string}|{type:'string';value:string}|{type:'boolean';value:boolean}|{type:'date';value:string};
export type FormulaParameter = {name:string;type:FormulaType;literal?:boolean;choices?:readonly string[];optional?:boolean};
export type FormulaFunction = {code:string;aliases:readonly string[];category:string;label:string;description:string;returns:FormulaType|'field';parameters:readonly FormulaParameter[];source:string};
export const PAY_FORMULA_REGISTRY_VERSION = 'payroll-formula-1';
/** Bump when Native source selection, authorization or numeric boundary semantics change. */
export const PAY_FORMULA_PROVIDER_VERSION = 'native-payroll-sources-1';
export const PAY_FORMULA_FIELD_TYPES:Readonly<Record<'profile'|'employee',Readonly<Record<string,FormulaType>>>> = {
 profile:{joinDate:'date',groupJoinDate:'date',resignationDate:'date',confirmationDate:'date',lastWorkingDate:'date',employmentType:'string',employeeNo:'string',departmentCode:'string',positionCode:'string',gradeCode:'string'},
 employee:{dateOfBirth:'date',gender:'string',nationality:'string',maritalStatus:'string'},
};
const code:FormulaParameter={name:'Pay Item Code',type:'string',literal:true};
const item=(codeName:string,category:string,label:string,description:string,source:string,aliases:string[]=[]):FormulaFunction=>({code:codeName,aliases,category,label,description,returns:'decimal',parameters:[code],source});
export const PAY_FORMULA_VARIABLE_CATEGORIES = [
 {code:'payItem',label:'Pay Items Code (Prorated)'},{code:'payItemNoProrate',label:'Pay Item Code (No Prorate)'},{code:'payItemInput',label:'Pay Items Input Value'},
 {code:'basic',label:'Basic Salary'},{code:'profile',label:'Employee Profile'},{code:'employee',label:'Employee Information'},
 {code:'input',label:'Input'},{code:'inputType',label:'Input Type'},{code:'joinDate',label:'Join Date'},
 {code:'groupJoinDate',label:'Group Join Date'},{code:'resignationDate',label:'Resignation Date'},{code:'history',label:'Another Pay Items'},
 {code:'rounding',label:'Rounding'},{code:'serviceLength',label:'Service Length'},
] as const;
export const PAY_FORMULA_FUNCTIONS:readonly FormulaFunction[] = [
 item('PayItem','payItem','Calculated Pay Item','Calculated and prorated value in this employee/run dependency plan.','current-run calculated pay item',['PayItems','PayItemsCode']),
 item('PayItemNoProrate','payItemNoProrate','Unprorated Pay Item','Calculated value before the owner applies this run’s proration.','current-run unprorated pay item',['PayItemCodeNoProrate']),
 item('PayItemInput','payItemInput','Pay Item input','Saved input before this payroll run evaluates its rule. Individual transactions supply their authoritative saved monetary amount; descriptive hours are not inferred.','current-run original input',['PayItemsInputValue']),
 {code:'Basic',aliases:['BasicSalary'],category:'basic',label:'Basic salary',description:'Effective basic salary at the authorized payroll date.',returns:'decimal',parameters:[],source:'effective compensation'},
 {code:'EmployeeProfile',aliases:['Profile'],category:'profile',label:'Employment field',description:'An allowlisted employment field. Dated assignments use the selected date; other recorded fields use their current owner snapshot.',returns:'field',parameters:[{name:'Field',type:'string',literal:true,choices:Object.keys(PAY_FORMULA_FIELD_TYPES.profile)}],source:'effective employment information'},
 {code:'EmployeeInformation',aliases:['Employee'],category:'employee',label:'Personal information',description:'An allowlisted personal field; underlying field permission is still required.',returns:'field',parameters:[{name:'Field',type:'string',literal:true,choices:Object.keys(PAY_FORMULA_FIELD_TYPES.employee)}],source:'permission-scoped person information'},
 {code:'Input',aliases:[],category:'input',label:'Current input',description:'Original input for the current Pay Item.',returns:'decimal',parameters:[],source:'current pay-item input'},
 {code:'InputType',aliases:[],category:'inputType',label:'Current input type',description:'Configured input type of the current Pay Item.',returns:'string',parameters:[],source:'current pay-item configuration'},
 {code:'JoinDate',aliases:[],category:'joinDate',label:'Company join date',description:'Recorded company join date at the effective payroll date.',returns:'date',parameters:[],source:'employment date owner'},
 {code:'GroupJoinDate',aliases:[],category:'groupJoinDate',label:'Group join date',description:'Recorded group service date at the effective payroll date.',returns:'date',parameters:[],source:'employment date owner'},
 {code:'ResignationDate',aliases:[],category:'resignationDate',label:'Resignation date',description:'Recorded resignation date; missing evidence is unavailable, not an invented date.',returns:'date',parameters:[],source:'employment movement owner'},
 {code:'AnotherPayItems',aliases:['History','PayItemHistory'],category:'history',label:'Historical Pay Item',description:'Exact saved item contribution for the selected period, cycle and result reference.',returns:'decimal',parameters:[code,{name:'Period',type:'string',literal:true},{name:'Cycle',type:'string',literal:true},{name:'Result reference',type:'string',literal:true}],source:'effective payroll-history result'},
 {code:'Rounding',aliases:['Round'],category:'rounding',label:'Round half away from zero',description:'Round an exact decimal to 0–12 decimal places, with ties away from zero.',returns:'decimal',parameters:[{name:'Value',type:'decimal'},{name:'Decimal places',type:'decimal',literal:true,optional:true}],source:'bounded exact-decimal evaluator'},
 {code:'ServiceLength',aliases:[],category:'serviceLength',label:'Service length',description:'Completed years, months or days using the selected recorded service date.',returns:'decimal',parameters:[{name:'Unit',type:'string',literal:true,choices:['years','months','days']},{name:'Basis',type:'string',literal:true,choices:['hiredOn','groupJoinDate','joinDate']}],source:'HR date and service-length owner'},
 {code:'Accumulation',aliases:[],category:'payItem',label:'Accumulation group',description:'Sum the explicitly configured, authorized Pay Item accumulation group.',returns:'decimal',parameters:[{name:'Group code',type:'string',literal:true}],source:'configured payroll accumulation group'},
 ...(['Payrate','OrdinaryRate','HoursPerDay','Rate'] as const).map((name):FormulaFunction=>({code:name,aliases:[],category:'input',label:name,description:'Effective payroll context. Payrate uses Monthly, Daily, Hourly or Custom Period; explicit numeric bindings come from the selected Pay Item.',returns:name==='Payrate'?'string':'decimal',parameters:[],source:'effective payroll rate context'})),
 ...(['JoinedThisMonth','GroupJoinedThisMonth','ResignedThisMonth'] as const).map((name):FormulaFunction=>({code:name,aliases:[],category:name==='JoinedThisMonth'?'joinDate':name==='GroupJoinedThisMonth'?'groupJoinDate':'resignationDate',label:name,description:'Whether the corresponding recorded lifecycle date falls in this payroll month.',returns:'boolean',parameters:[],source:'HR date owner and selected payroll period'})),
 {code:'Date',aliases:[],category:'profile',label:'Calendar date',description:'A literal ISO calendar date for typed comparisons.',returns:'date',parameters:[{name:'ISO date',type:'string',literal:true}],source:'calendar-date validator'},
];
export function payFormulaFunction(code:string):FormulaFunction|undefined{return PAY_FORMULA_FUNCTIONS.find(fn=>[fn.code,...fn.aliases].some(name=>name.toLowerCase()===code.toLowerCase()));}
