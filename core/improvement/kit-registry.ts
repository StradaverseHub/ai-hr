/** Step 5c — capabilities generated through the capability kit (./kit.ts).
 *
 * Every entry here gets the standard contracts (./kit-contracts.ts) from test/capability-kit-contracts.test.ts
 * without writing a test of its own. The first entries regenerate the four step 4 capabilities from their native
 * owner, permission and entity alone; test/capability-kit-equivalence.test.ts proves each equals the
 * hand-declared read, tool spec, registry row and harness offer (core/semantic-model/entities-explain.ts,
 * entities-setup.ts, core/explainers/capabilities.ts). A new capability is added here, and its entity registered
 * in core/semantic-model/generate.ts, rather than declared by hand. Pure declarations. */
import {EXPLAIN_ENTITIES,EXPLAIN_READS} from '../semantic-model/entities-explain';
import {SETUP_ENTITIES,SETUP_READS} from '../semantic-model/entities-setup';
import type {EntityId,OwnerAnchor,SemanticEntity,SemanticRead} from '../semantic-model/types';
import {kitCapability,type KitCapability,type KitDeclaration} from './kit';

const entity=(id:EntityId):SemanticEntity=>{const found=[...EXPLAIN_ENTITIES,...SETUP_ENTITIES].find(row=>row.id===id);if(!found)throw Error('Unknown kit entity.');return found;};
const read=(name:string):SemanticRead=>{const found=[...EXPLAIN_READS,...SETUP_READS].find(row=>row.name===name);if(!found)throw Error('Unknown kit read.');return found;};
/** Purpose and inputs are the declaration's own words; the kit generates the rest. */
const declare=(name:string,owner:OwnerAnchor,permission:KitDeclaration['permission']):KitDeclaration=>{
 const row=read(name);return{name,purpose:row.purpose,input:row.input,owner,permission,entity:entity(row.entity)};
};

export const KIT_DECLARATIONS:readonly KitDeclaration[]=Object.freeze([
 declare('explain_payslip_statutory','core/statutory-explain.ts#explainStatutory',{module:'payroll',admin:false}),
 declare('explain_leave_entitlement','core/read.ts#leaveEntitlementBreakdown',{module:'leave',admin:false}),
 declare('explain_attendance_day','core/attendance-explain.ts#explainAttendanceDay',{module:'attendance',admin:false}),
 declare('setup_copilot','core/setup-copilot/copilot.ts#setupCopilot',{module:null,admin:true}),
]);
export const KIT_CAPABILITIES:readonly KitCapability[]=Object.freeze(KIT_DECLARATIONS.map(kitCapability));
