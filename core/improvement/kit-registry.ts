/** Step 5c — capabilities generated through the capability kit (./kit.ts).
 *
 * Every entry here gets the standard contracts from test/capability-kit-contracts.test.ts
 * without writing a test of its own. The first entries regenerate the four step 4 capabilities from their native
 * owner, permission and entity alone; test/capability-kit-equivalence.test.ts proves each equals the
 * hand-declared read, tool spec, registry row and harness offer (core/semantic-model/entities-explain.ts,
 * entities-setup.ts, entities-metrics.ts, core/explainers/capabilities.ts). A new capability is added here, and its entity registered
 * in core/semantic-model/generate.ts, rather than declared by hand. Pure declarations. */
import {EXPLAIN_ENTITIES,EXPLAIN_READS} from '../semantic-model/entities-explain';
import {SETUP_ENTITIES,SETUP_READS} from '../semantic-model/entities-setup';
import {METRIC_ENTITIES,METRIC_READS} from '../semantic-model/entities-metrics';
import {WHY_ENTITIES,WHY_READS} from '../semantic-model/entities-why';
import {LOOP_ENTITIES,LOOP_READS} from '../semantic-model/entities-loops';
import {PAYROLL_READINESS_ENTITIES,PAYROLL_READINESS_READS} from '../semantic-model/entities-payroll-readiness';
import {PAYROLL_LOOP_ENTITIES,PAYROLL_LOOP_READS} from '../semantic-model/entities-payroll-loops';
import {HANDBOOK_ENTITIES,HANDBOOK_READS} from '../semantic-model/entities-handbook';
import {QUALITY_ENTITIES,QUALITY_READS} from '../semantic-model/entities-quality';
import type {EntityId,OwnerAnchor,SemanticEntity,SemanticRead} from '../semantic-model/types';
import {kitCapability,type KitCapability,type KitDeclaration} from './kit';

const entity=(id:EntityId):SemanticEntity=>{const found=[...EXPLAIN_ENTITIES,...SETUP_ENTITIES,...METRIC_ENTITIES,...WHY_ENTITIES,...LOOP_ENTITIES,...PAYROLL_READINESS_ENTITIES,...PAYROLL_LOOP_ENTITIES,...HANDBOOK_ENTITIES,...QUALITY_ENTITIES].find(row=>row.id===id);if(!found)throw Error('Unknown kit entity.');return found;};
const read=(name:string):SemanticRead=>{const found=[...EXPLAIN_READS,...SETUP_READS,...METRIC_READS,...WHY_READS,...LOOP_READS,...PAYROLL_READINESS_READS,...PAYROLL_LOOP_READS,...HANDBOOK_READS,...QUALITY_READS].find(row=>row.name===name);if(!found)throw Error('Unknown kit read.');return found;};
/** Purpose and inputs are the declaration's own words; the kit generates the rest. */
const declare=(name:string,owner:OwnerAnchor,permission:KitDeclaration['permission']):KitDeclaration=>{
 const row=read(name);return{name,purpose:row.purpose,input:row.input,owner,permission,entity:entity(row.entity)};
};

export const KIT_DECLARATIONS:readonly KitDeclaration[]=Object.freeze([
 declare('explain_payslip_statutory','core/statutory-explain.ts#explainStatutory',{module:'payroll',admin:false}),
 declare('explain_leave_entitlement','core/read.ts#leaveEntitlementBreakdown',{module:'leave',admin:false}),
 declare('explain_attendance_day','core/attendance-explain.ts#explainAttendanceDay',{module:'attendance',admin:false}),
 declare('setup_copilot','core/setup-copilot/copilot.ts#setupCopilot',{module:null,admin:true}),
 declare('password_policy_guidance','core/explainers/capabilities.ts#passwordPolicyGuidance',{module:null,admin:true}),
 declare('correction_controls_guidance','core/explainers/capabilities.ts#correctionControlsGuidance',{module:'payroll',admin:true}),
 declare('organisation_tagging_guidance','core/explainers/capabilities.ts#organisationTaggingGuidance',{module:null,admin:true}),
 // AI Centre issue 13b: governed pay averages (core/semantic-model/entities-metrics.ts), offered under payroll access.
 declare('pay_aggregates','packs/payroll/pay-averages.ts#payAverages',{module:'payroll',admin:false,access:'payroll'}),
 // AI v2 W7: governed workforce metrics (core/semantic-model/entities-metrics.ts), offered to managers and administrators.
 declare('workforce_metrics','core/workforce-metrics.ts#workforceMetrics',{module:null,admin:false,access:'team'}),
 // AI v2 W5: "Why?" on the pay difference and the claim limits (core/semantic-model/entities-why.ts).
 declare('explain_pay_difference','core/pay-difference.ts#comparePayPeriods',{module:'payroll',admin:false}),
 declare('explain_claim_limit','core/claims.ts#employeeClaimTypesTx',{module:'claims',admin:false}),
 // AI v2 W8: the loops overview (core/semantic-model/entities-loops.ts), offered to administrators only.
 declare('loops_overview','core/loops/views.ts#loopsOverview',{module:null,admin:true}),
 // AI v2 Phase 2 P2-3: the person's own "Before payroll" checklist (core/semantic-model/entities-payroll-readiness.ts).
 declare('my_payroll_readiness','core/pre-salary/person-items.ts#readMyPayrollReadiness',{module:null,admin:false}),
 // AI v2 Phase 2 (wave 1 integration): the payroll-cycle loop pages (core/semantic-model/entities-payroll-loops.ts), administrators only.
 declare('payroll_cycle_status','core/loops/payroll-cycle-views.ts#payrollCycleOverview',{module:'payroll',admin:true}),
 declare('salary_payroll_checks','core/loops/payroll-cycle-views.ts#salaryLoopPage',{module:'payroll',admin:true}),
 declare('payroll_loop_settings','core/loops/payroll-cycle-views.ts#payrollLoopSettingsPage',{module:'payroll',admin:true}),
 declare('payroll_audit_status','core/payroll-audit/status.ts#auditLoopSummary',{module:'payroll',admin:true}),
 // AI v2 Phase 2 P2-5: the approved company policies in force (core/semantic-model/entities-handbook.ts).
 declare('my_policy_handbook','core/handbook/ask.ts#readPoliciesInForce',{module:null,admin:false}),
 // AI v2 Phase 2 P2-6: AI quality for HR and group administrators (core/semantic-model/entities-quality.ts).
 declare('ai_quality_summary','core/learning/quality.ts#aiQuality',{module:null,admin:true}),
]);
export const KIT_CAPABILITIES:readonly KitCapability[]=Object.freeze(KIT_DECLARATIONS.map(kitCapability));
