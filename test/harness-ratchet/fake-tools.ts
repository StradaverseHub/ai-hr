/** Fictional tool bindings for harness tests that need no database. Same names and input schemas as the real
 * offer (reads from the semantic model, context tools from core/product-context), fixed fictional outputs,
 * and a log of exactly what each owner was asked to run. The runner's gate and offer policy still apply. */
import type {ToolBinding,ToolProvider,ToolRun} from '../../core/harness/tools';
import {contextToolSpecs} from '../../core/semantic-model/generate';
import {SEMANTIC_READS} from '../../core/semantic-model/entities';
import {CONTEXT_TOOL_SPECS} from '../../core/product-context/tools';
import type {AiToolSpec} from '../../lib/ai/types';

export const FICTIONAL={ownEmployment:'11111111-1111-4111-8111-111111111111',leaveType:'22222222-2222-4222-8222-222222222222',
 otherEmployment:'33333333-3333-4333-8333-333333333333',company:'Fictional Ceria Sdn Bhd'} as const;
export type Dispatch=Readonly<{tool:string;input:Readonly<Record<string,unknown>>}>;
type Outputs=Partial<Record<string,(input:Record<string,unknown>)=>ToolRun>>;

const balances=(leaveType='Annual Leave'):ToolRun=>({ok:true,content:{ok:true,employments:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,
 balances:[{leaveTypeId:FICTIONAL.leaveType,leaveType,accrued:17.25,taken:3,pending:1,available:13.25,sharedPoolName:null,balance:14.25,withheld:false}]}]}});
export const DEFAULT_OUTPUTS:Outputs={
 my_leave_balances:()=>balances(),
 leave_entitlement_explain:input=>input.leave_type_id===FICTIONAL.leaveType
  ?{ok:true,content:{ok:true,leaveTypeId:FICTIONAL.leaveType,asOf:input.as_of,employments:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,leaveType:'Annual Leave',
   cycleStart:'2026-01-01',totalEntitlement:17.25,currentYearEntitlement:17.25,withheld:false,
   transactions:{rows:[{effectiveOn:'2026-01-01',entryType:'accrual',days:17.25,sourceRequestId:null,reason:'Opening fictional accrual'}],truncated:false,totalRows:1}}]}}
  :{ok:false,refusal:'no_data',content:{ok:false,refusal:'no_data',message:'No entitlement on that leave type.'}},
 employee_profile:input=>input.employment_id===FICTIONAL.ownEmployment
  ?{ok:true,content:{ok:true,employee:{employmentId:FICTIONAL.ownEmployment,employeeCode:'EMP-0042',name:'Fictional Aina',company:FICTIONAL.company,gradeName:'G5',
   holidayGroupName:'Selangor',workState:'Selangor',hiredOn:'2020-01-01',joinDate:'2020-01-01',terminatedOn:null}}}
  :{ok:false,refusal:'not_visible',content:{ok:false,refusal:'not_visible',message:'That employee is not visible to the asking user.'}},
 my_payslip_summary:()=>({ok:true,content:{ok:true,rows:[{payPeriod:'2026-09',company:FICTIONAL.company,runType:'regular',gross:5234.5,deductions:812.25,net:4422.25}],truncated:false,totalRows:1}}),
 product_destinations:()=>({ok:true,content:[{href:'/leave',label:'Leave',module:'leave'},{href:'/me/payslip',label:'My payslips',module:'payroll'}]}),
 product_guidance:()=>({ok:true,content:[{title:'Applying for leave',section:'Open Leave and choose Apply.',href:'/leave'}]}),
 available_actions:()=>({ok:true,content:[{id:'leave.apply',purpose:'Apply for leave for yourself.',reviewRoute:'/assistant/leave',collects:['leaveTypeId','reason']}]}),
 approval_queue:()=>({ok:true,content:{waiting:[]}}),
};
const SUGGEST_SPEC:AiToolSpec={name:'suggest_action',description:'Point the person to the page where they complete and confirm one change from available_actions. Nothing is prepared or submitted.',
 inputSchema:{type:'object',properties:{action:{type:'string',enum:['leave.apply']},details:{type:'object',additionalProperties:{type:'string'}}},required:['action'],additionalProperties:false} as AiToolSpec['inputSchema']};

/** `admin` adds the administrator-only context tools; `outputs` overrides any binding's result. */
export function fakeTools(options:Readonly<{admin?:boolean;outputs?:Outputs;poisonLeaveType?:string}>={}):{provider:ToolProvider;dispatched:Dispatch[]}{
 const dispatched:Dispatch[]=[];
 const outputs:Outputs={...DEFAULT_OUTPUTS,...(options.poisonLeaveType?{my_leave_balances:()=>balances(options.poisonLeaveType)}:{}),...options.outputs};
 const bind=(name:string,kind:ToolBinding['kind'],spec:AiToolSpec,entity:ToolBinding['entity'],identifierInputs:readonly string[]):ToolBinding=>({name,kind,spec,entity,identifierInputs,
  async run(input){dispatched.push({tool:name,input:{...input}});const output=outputs[name];
   if(name==='suggest_action')return input.action==='leave.apply'?{ok:true,content:{suggested:true,action:'leave.apply',reviewRoute:'/assistant/leave',inlineCard:true},suggestion:{action:'leave.apply',reviewRoute:'/assistant/leave',inlineCard:true}}
    :{ok:false,refusal:'not_available',content:{suggested:false,reason:'not_available'}};
   return output?output(input):{ok:true,content:{ok:true,rows:[],truncated:false,totalRows:0}};}});
 const reads=contextToolSpecs().map(spec=>{const read=SEMANTIC_READS.find(row=>row.name===spec.name)!;return bind(spec.name,'read',spec,read.entity,read.input.filter(input=>input.identifier).map(input=>input.name));});
 const context=(['product_destinations','product_guidance','available_actions','approval_queue',...(options.admin?['setup_readiness','company_setup'] as const:[])] as const)
  .map(name=>bind(name,'context',CONTEXT_TOOL_SPECS[name],null,[]));
 const provider:ToolProvider=async(_ctx,_scope,actions)=>({bindings:[...context,...reads,...(actions?[bind('suggest_action','suggest',SUGGEST_SPEC,null,[])]:[])],
  reviewRoutes:['/assistant/leave'],destinations:['/leave','/me/payslip','/assistant','/approvals']});
 return{provider,dispatched};
}
