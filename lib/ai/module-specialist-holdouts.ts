/** Immutable independently authored domain expectations. Does NOT import/invoke the candidate engine.
 * These are fictional canonical projections, not production HR fixtures or native security evidence. */
import type {AgentModuleCode} from './module-agents';
import type {SpecialistFinding} from './module-specialists';
import {routingDigest} from './module-agent-routing';
export type SpecialistHoldout=Readonly<{id:string;module:AgentModuleCode;data:unknown;expected:readonly SpecialistFinding[]}>;
const b=(rows:unknown[],truncated=false)=>({rows,truncated}),f=(module:AgentModuleCode,id:string,data:unknown,expected:SpecialistFinding[]):SpecialistHoldout=>Object.freeze({id:module+':'+id,module,data,expected:Object.freeze(['scope_current_caller' as const,...expected].sort())});
const states:SpecialistHoldout[]=[
 f('employees','active',{rows:[{status:'active',employeeCode:'FIC',company:'Fictional',hiredOn:'2020-01-01',terminatedOn:null}],truncated:false},['employment_active']),
 f('employees','multiple-and-terminated',b([{status:'active',terminatedOn:null},{status:'terminated',terminatedOn:'2026-01-01'}]),['choose_actual_employment','employment_active','employment_inactive']),
 f('org','administrative',b([{company:'Fictional',reportingLines:[{name:'Permitted manager',lineType:'administrative'}]}]),['reporting_recorded']),
 f('org','only-functional',b([{reportingLines:[{name:'Permitted functional manager',lineType:'functional'}]}]),['reporting_recorded','administrative_manager_missing']),
 f('leave','pending-with-available',b([{balances:[{leaveType:'Canonical Annual',available:4,taken:1,pending:2,withheld:false}]}]),['leave_available_recorded','leave_pending_not_approved']),
 f('leave','hidden-summary',b([{balances:[{leaveType:'Canonical Annual',available:null,pending:null,taken:2,withheld:true}]}]),['withheld_not_reconstructable']),
 f('ess','payment-gap',{employees:1,ready:0,gaps:[{id:'no_bank_account',count:1,blocks:'payment'}]},['readiness_gaps']),
 f('ess','clear',{employees:1,ready:1,gaps:[]},['readiness_currently_clear']),
 f('approvals','pending',b([{leaveType:'Canonical Annual',status:'pending',startDate:'2026-01-01',endDate:'2026-01-01',hasRejectedDates:false}]),['own_request_pending']),
 f('approvals','partial-dates',b([{leaveType:'Canonical Annual',status:'approved',hasRejectedDates:true}]),['own_request_decided','request_partially_rejected']),
 f('knowledge_base','published-index',b([{title:'Permitted policy',category:'Work',updatedAt:'2026-01-01'}]),['published_index_not_policy_text']),
 f('knowledge_base','another-index-not-body',b([{title:'Permitted procedure',category:'Procedure',updatedAt:null,body:'PRIVATE_POISON'}]),['published_index_not_policy_text']),
 f('payroll','stored-released',b([{payPeriod:'2026-01',gross:'7319.00',deductions:'100.00',net:'7001.2345',currency:'MYR',runType:'regular',runSeq:1}]),['released_pay_stored_only']),
 f('payroll','missing-net-currency',b([{payPeriod:'2026-01',gross:'7319.00',deductions:'100.00',net:null,currency:null}]),['released_pay_stored_only','pay_record_incomplete_no_inference']),
 f('attendance','late',b([{date:'2026-01-01',status:'late',workedMinutes:470,otMinutes:0}]),['attendance_exception_recorded']),
 f('attendance','present',b([{date:'2026-01-01',status:'present',workedMinutes:480,otMinutes:0}]),['attendance_status_recorded']),
 f('claims','draft',{hasEmployment:true,claims:[{claimType:'Travel',status:'draft',incurredOn:'2026-01-01',createdAt:'2026-01-01',decidedAt:null,paidAt:null}],truncated:false},['claim_draft_not_submitted']),
 f('claims','pending',{hasEmployment:true,claims:[{claimType:'Travel',status:'pending',paidAt:null}],truncated:false},['claim_pending_not_approved']),
 f('claims','approved-unpaid',{hasEmployment:true,claims:[{claimType:'Travel',status:'approved',paidAt:null}],truncated:false},['claim_approved_not_paid']),
 f('claims','paid',{hasEmployment:true,claims:[{claimType:'Travel',status:'paid',paidAt:'2026-01-02'}],truncated:false},['claim_payment_recorded']),
 f('performance','standard-unreleased',b([{cycleName:'Standard',framework:'standard',artifact:'review',status:'manager_review',released:false}]),['standard_review_unreleased']),
 f('performance','standard-released',b([{cycleName:'Standard',framework:'standard',artifact:'review',status:'acknowledged',released:true}]),['standard_review_released']),
 f('performance','onehr-review',b([{cycleName:'OneHR',framework:'onehr',artifact:'review',status:'closed',released:null}]),['onehr_review_status_not_rating']),
 f('performance','onehr-plan',b([{cycleName:'OneHR',framework:'onehr',artifact:'plan',status:'closed',released:null}]),['onehr_plan_status_not_endorsement']),
 f('rewards','draft',b([{cycle:'Fictional cycle',unit:'Fictional unit',kind:'annual',year:2026,status:'draft',revision:1}]),['reward_draft_not_awarded']),
 f('rewards','approved',b([{cycle:'Fictional cycle',status:'approved'}]),['reward_approved_not_posted']),
 f('rewards','posted',b([{cycle:'Fictional cycle',status:'posted'}]),['reward_posted_not_processed_or_paid']),
 f('lifecycle','remaining',{status:'in_progress',progress:{done:1,total:2,percent:50},steps:[{label:'Human equipment acknowledgement',applicable:true,done:false}]},['lifecycle_steps_remaining']),
 f('lifecycle','not-applicable-not-complete',{status:'in_progress',progress:{done:1,total:2,percent:50},steps:[{label:'Applicable native step',applicable:true,done:true},{label:'Not applicable',applicable:false,done:false}]},['lifecycle_progress_unknown']),
 f('lifecycle','complete',{status:'completed',progress:{done:2,total:2,percent:100},steps:[{label:'Native verified step',applicable:true,done:true}]},['lifecycle_progress_complete']),
 f('lifecycle','unknown-progress',{status:'in_progress',progress:{done:null,total:null,percent:null},steps:[]},['lifecycle_progress_unknown']),
 f('toil','banked',b([{active:2,taken:0,expired:0,convertedToPay:0,leaveUnit:'day',soonestExpiry:'2026-02-01',rows:b([{workedDate:'2026-01-01',expiresOn:'2026-02-01',daysCredited:2,daysTaken:0,remaining:2,status:'active'}])}]),['credit_recorded_not_new_eligibility']),
 f('toil','expired-converted',b([{active:0,taken:0,expired:2,convertedToPay:1,leaveUnit:'day',rows:b([{status:'expired'}])}]),['credit_expired_not_available','credit_pay_conversion_not_payslip']),
 f('multi_cycle_payroll','regular-index',b([{cycleName:'Monthly',payPeriod:'2026-01',runType:'regular',runSeq:1}]),['released_run_index_not_run_creation']),
 f('multi_cycle_payroll','additional-index',b([{cycleName:'Monthly',payPeriod:'2026-01',runType:'additional',runSeq:2}]),['released_run_index_not_run_creation','additional_released_run_recorded']),
 f('typed_pay_components','stored-decimal',b([{payPeriod:'2026-01',currency:'MYR',lines:b([{code:'FIC',name:'Recorded component',amount:'1234.5678'}])}]),['component_amount_stored_only']),
 f('typed_pay_components','missing-amount',b([{payPeriod:'2026-01',currency:'MYR',lines:b([{code:'FIC',name:'Recorded component',amount:null}])}]),['component_amount_unknown']),
 f('country-my','filing-gap',{employees:1,ready:0,gaps:[{id:'no_identity',count:1,blocks:'statutory_filing'}]},['readiness_gaps','statutory_gap_not_rate_decision']),
 f('country-my','clear-not-filed',{employees:1,ready:1,gaps:[]},['readiness_currently_clear','statutory_readiness_not_filing']),
 f('notifications','unread',b([{createdAt:'2026-01-01',readAt:null}]),['notification_unread_not_delivery_proof']),
 f('notifications','read',b([{createdAt:'2026-01-01',readAt:'2026-01-02'}]),['notification_read_recorded']),
 f('system_explorer','withheld',{withheldTables:2,tables:b([{table:'employment',module:'employees'}])},['schema_inventory_not_record_access','schema_partly_withheld']),
 f('system_explorer','visible-only',{withheldTables:0,tables:b([{table:'employment',module:'employees'}])},['schema_inventory_not_record_access']),
 f('assistant','catalogue',{capabilities:[{module:'leave',capability:'own_leave_balances'}],effects:'human-confirmation-only'},['catalogue_not_permission','human_confirmation_owns_effects']),
 f('assistant','second-catalogue',{capabilities:[{module:'payroll',capability:'own_released_payslips'},{module:'claims',capability:'own_claim_statuses'}],effects:'human-confirmation-only'},['catalogue_not_permission','human_confirmation_owns_effects']),
 f('system_testing','reported-pass',b([{caseNo:42,title:'Assigned canonical case',moduleCode:'leave',ordinal:1,status:'passed',updatedAt:'2026-01-01'}]),['human_test_pass_not_independent_verification']),
 f('system_testing','reported-failure',b([{caseNo:42,title:'Assigned canonical case',moduleCode:'leave',ordinal:1,status:'failed',updatedAt:'2026-01-01'}]),['human_test_failure_needs_native_followup']),
 f('system_testing','not-applicable',b([{caseNo:42,title:'Assigned canonical case',moduleCode:'leave',ordinal:1,status:'not_applicable',updatedAt:null}]),['test_not_applicable_not_pass']),
];
const empty:Partial<Record<AgentModuleCode,unknown>>={ess:{employees:0,ready:0,gaps:[]},'country-my':{employees:0,ready:0,gaps:[]},claims:{hasEmployment:false,claims:[],truncated:false},lifecycle:null,system_explorer:{withheldTables:0,tables:b([])},assistant:{capabilities:[],effects:'human-confirmation-only'}};
for(const module of [...new Set(states.map(row=>row.module))]){
 const data=Object.prototype.hasOwnProperty.call(empty,module)?empty[module]:b([]),expected:SpecialistFinding[]=module==='ess'?['readiness_no_subject']:module==='country-my'?['readiness_no_subject','statutory_readiness_not_filing']:module==='system_explorer'?['schema_inventory_not_record_access']:module==='assistant'?['catalogue_not_permission','human_confirmation_owns_effects']:[];
 // Readiness and schema have a real aggregate card even at zero; never turn zero into an employment.
 if(!['ess','country-my','system_explorer'].includes(module))expected.push('empty_is_not_tenant_absence');
 states.push(f(module,'empty-scope',data,expected));
 const base=states.find(row=>row.module===module)!;
 if(!['ess','country-my','lifecycle','assistant'].includes(module)){const limited=structuredClone(base.data) as Record<string,unknown>;if(module==='system_explorer')(limited.tables as {truncated:boolean}).truncated=true;else limited.truncated=true;states.push(f(module,'truncated-scope',limited,[...base.expected.filter(value=>value!=='scope_current_caller'),'bounded_results']));}
}
export const SPECIALIST_EXPECTED_FACTS:Readonly<Record<string,readonly Readonly<{field:string;value:string|number|boolean|null}>[]>>=Object.freeze({
 'employees:active':[{field:'workStatus',value:'active'}], 'org:administrative':[{field:'reportingKind',value:'administrative'}], 'leave:pending-with-available':[{field:'available',value:4},{field:'pending',value:2}], 'leave:hidden-summary':[{field:'taken',value:2}],
 'ess:payment-gap':[{field:'blockingEffect',value:'payment'}], 'approvals:partial-dates':[{field:'hasRejectedDates',value:true}], 'knowledge_base:published-index':[{field:'category',value:'Work'}], 'payroll:stored-released':[{field:'net',value:'7001.2345'}], 'payroll:missing-net-currency':[{field:'net',value:null},{field:'currency',value:null}],
 'attendance:late':[{field:'workedMinutes',value:470}], 'claims:approved-unpaid':[{field:'status',value:'approved'},{field:'paidAt',value:null}], 'claims:paid':[{field:'status',value:'paid'},{field:'paidAt',value:'2026-01-02'}], 'performance:standard-unreleased':[{field:'released',value:false}], 'performance:onehr-plan':[{field:'framework',value:'onehr'},{field:'artifact',value:'plan'}],
 'rewards:posted':[{field:'status',value:'posted'}], 'lifecycle:complete':[{field:'progressDone',value:2}], 'toil:banked':[{field:'activeCredit',value:2}], 'multi_cycle_payroll:additional-index':[{field:'runSequence',value:2}], 'typed_pay_components:stored-decimal':[{field:'amount',value:'1234.5678'}], 'country-my:filing-gap':[{field:'blockingEffect',value:'statutory_filing'}],
 'notifications:unread':[{field:'notificationReadAt',value:null}], 'system_explorer:withheld':[{field:'withheldTables',value:2}], 'system_testing:reported-pass':[{field:'status',value:'passed'},{field:'testingInstructionVersion',value:1}]
});
function freeze(value:unknown):void{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}}
for(const row of states)freeze(row);freeze(SPECIALIST_EXPECTED_FACTS);
export const SPECIALIST_HOLDOUTS:readonly SpecialistHoldout[]=Object.freeze(states);
export function specialistInputDigest(module:AgentModuleCode){return routingDigest(['specialist-independent-domain-input-v1',SPECIALIST_HOLDOUTS.filter(row=>row.module===module),Object.entries(SPECIALIST_EXPECTED_FACTS).filter(([id])=>id.startsWith(module+':'))]);}
export function specialistSuiteDigest(module:AgentModuleCode){return routingDigest(['specialist-domain-suite-v1',module,specialistInputDigest(module),'exact-facts+domain-meaning+fresh-native-nonempty+no-effect+scope']);}
