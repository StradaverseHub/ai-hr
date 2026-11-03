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
import {PAYROLL_READINESS_ENTITIES,PAYROLL_READINESS_READS} from '../semantic-model/entities-payroll-readiness';
import type {EntityId,OwnerAnchor,SemanticEntity,SemanticRead} from '../semantic-model/types';
import {kitCapability,type KitCapability,type KitDeclaration} from './kit';

const entity=(id:EntityId):SemanticEntity=>{const found=[...EXPLAIN_ENTITIES,...SETUP_ENTITIES,...METRIC_ENTITIES,...WHY_ENTITIES,...PAYROLL_READINESS_ENTITIES].find(row=>row.id===id);if(!found)throw Error('Unknown kit entity.');return found;};
const read=(name:string):SemanticRead=>{const found=[...EXPLAIN_READS,...SETUP_READS,...METRIC_READS,...WHY_READS,...PAYROLL_READINESS_READS].find(row=>row.name===name);if(!found)throw Error('Unknown kit read.');return found;};
/** Purpose and inputs are the declaration's own words; the kit generates the rest. */
const declare=(name:string,owner:OwnerAnchor,permission:KitDeclaration['permission']):KitDeclaration=>{
 const row=read(name);return{name,purpose:row.purpose,input:row.input,owner,permission,entity:entity(row.entity)};
};

export const KIT_DECLARATIONS:readonly KitDeclaration[]=Object.freeze([
 declare('explain_payslip_statutory','core/statutory-explain.ts#explainStatutory',{module:'payroll',admin:false}),
 declare('explain_leave_entitlement','core/read.ts#leaveEntitlementBreakdown',{module:'leave',admin:false}),
 declare('explain_attendance_day','core/attendance-explain.ts#explainAttendanceDay',{module:'attendance',admin:false}),
 declare('setup_copilot','core/setup-copilot/copilot.ts#setupCopilot',{module:null,admin:true}),
 // AI Centre issue 13b: governed pay averages (core/semantic-model/entities-metrics.ts), offered under payroll access.
 declare('pay_aggregates','packs/payroll/pay-averages.ts#payAverages',{module:'payroll',admin:false,access:'payroll'}),
 // AI v2 W7: governed workforce metrics (core/semantic-model/entities-metrics.ts), offered to managers and administrators.
 declare('workforce_metrics','core/workforce-metrics.ts#workforceMetrics',{module:null,admin:false,access:'team'}),
 // AI v2 W5: "Why?" on the pay difference and the claim limits (core/semantic-model/entities-why.ts).
 declare('explain_pay_difference','core/pay-difference.ts#comparePayPeriods',{module:'payroll',admin:false}),
 declare('explain_claim_limit','core/claims.ts#employeeClaimTypesTx',{module:'claims',admin:false}),
 // AI v2 Phase 2 P2-3: the person's own "Before payroll" checklist (core/semantic-model/entities-payroll-readiness.ts).
 declare('my_payroll_readiness','core/pre-salary/person-items.ts#readMyPayrollReadiness',{module:null,admin:false}),
]);
export const KIT_CAPABILITIES:readonly KitCapability[]=Object.freeze(KIT_DECLARATIONS.map(kitCapability));
