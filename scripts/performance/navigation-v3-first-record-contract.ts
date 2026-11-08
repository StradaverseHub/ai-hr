/** Fictional inputs and required native owner calls; no DB import or execution.
 * Returned rows/UUIDs remain untrusted hints until the NOT-YET-COMMISSIONED native
 * resolver and actual browser prove their principal/source/record custody. */
import {z} from 'zod';
import {requireEmployeeCode} from '../../lib/employee-code';
import {missingToCreate,type EmployeeDraftData} from '../../lib/employee-draft-schema';
import {freezeNavigationV3Value} from './navigation-v3-protocol';
const actorIndex=z.number().int().min(0).max(499);
const draftInput=z.object({companyId:z.guid(),fullName:z.string().min(1).max(100),primaryEmail:z.email(),employeeIdMode:z.literal('manual'),employeeCode:z.string().min(1).max(30)}).strict();
export type NavigationV3DraftInput=z.infer<typeof draftInput>;
/** These are input facts generated independently of a later page/reader result. */
export function navigationV3DraftInput(runId:number,index:number,companyId:string):Readonly<NavigationV3DraftInput>{
 if(!Number.isSafeInteger(runId)||runId<1)throw Error('Actual positive fixture run identity required');
 actorIndex.parse(index);
 const employeeCode=requireEmployeeCode(`NAVD-${runId}-${index}`);
 const input=draftInput.parse({companyId,fullName:`V3 Fictional Draft ${runId} ${index}`,
  primaryEmail:`v3-draft-${runId}-${index}@example.invalid`,employeeIdMode:'manual',employeeCode});
 const data:EmployeeDraftData={profile:{fullName:input.fullName,primaryEmail:input.primaryEmail,employeeIdMode:input.employeeIdMode,employeeCode:input.employeeCode},employment:{companyId:input.companyId}};
 if(missingToCreate(data,{employeeIdRule:null}).length)throw Error('Canonical draft creation inputs incomplete');
 return freezeNavigationV3Value(input);
}
/** Does not create another employment or change the 500-person workload. */
export function navigationV3ExistingPersonInputs(index:number){
 actorIndex.parse(index);return Object.freeze({actorIndex:index,fullName:'PERF Person '+String(index).padStart(4,'0'),employeeCode:'PERF'+String(index).padStart(4,'0')});
}
const draftRow=z.object({id:z.guid(),companyId:z.guid(),currentStep:z.literal(1),reservedEmployeeCode:z.string().min(1),
 data:z.object({profile:z.object({fullName:z.string(),primaryEmail:z.string(),employeeCode:z.string(),employeeIdMode:z.literal('manual')}),employment:z.object({companyId:z.guid()})})});
/** Equality of selected seed fields only; this neither authenticates the supplied
 * row nor certifies visibility, all default fields, audit or permission. */
export function assertNavigationV3DraftInputEquality(input:NavigationV3DraftInput,created:unknown,readBack:unknown):void{
 const expected=draftInput.parse(input),returned=z.object({id:z.guid(),employeeCode:z.string()}).strict().parse(created),row=draftRow.parse(readBack);
 if(row.id!==returned.id||returned.employeeCode!==expected.employeeCode||row.companyId!==expected.companyId
  ||row.data.employment.companyId!==expected.companyId||row.reservedEmployeeCode!==expected.employeeCode||row.data.profile.employeeCode!==expected.employeeCode
  ||row.data.profile.fullName!==expected.fullName||row.data.profile.primaryEmail!==expected.primaryEmail)throw Error('V3 draft seed inputs and observations differ');
}
/** Closed probes still require an admitted actual app connection and actual
 * canonical owner implementation. These strings are owner references, NOT SQL,
 * executable callbacks, copied authorization predicates or outcome assertions. */
export const NAVIGATION_V3_FIRST_NATIVE_REQUIREMENTS=freezeNavigationV3Value([
 {family:'personnel-record',allocation:'existing-system-employment',
  principalOwner:'lib/session.ts:resolveWorkosPrincipal/withEntitlements + lib/internal-auth/service.ts:readSession',
  nativeOwners:['core/ai-principal.ts:assertAiPresentationPrincipalTx','core/workforce-access.ts:assertWorkforcePresentationEmploymentTx','core/read.ts:employeeDetail(ctx,employmentId,workforce,existingTx)'],
  expectedInputOwner:'scripts/performance/system-fixture.mjs:hireEmployee + PERF code/name inputs',
  missing:['exact native lease and source/lifetime admission','child-record reservations/nonempty data per panel','actual content/denial/foreign/revocation browser oracles']},
 {family:'self-profile',allocation:'existing-system-actor-own-employment',
  principalOwner:'lib/session.ts:resolveWorkosPrincipal/withEntitlements + lib/internal-auth/service.ts:readSession',
  nativeOwners:['core/read.ts:myOwnEmploymentSubjectsTx(profileEdit:true)','core/profile-edit-policy.ts:readProfilePresentationSnapshotPolicyTx','core/profile-edit.ts:readOwnProfileWorkspace(existingTx)','core/profile-view.ts:readOwnProfileFacts'],
  expectedInputOwner:'scripts/performance/system-fixture.mjs:actual actor person/employment links',
  missing:['readOwnProfileFacts currently fans out independent singleton transactions; no max1/same-snapshot fiction','native policy determines actual hidden/read-only/editable content; never copied by planner','own unavailable vs explicit subject chooser/error outcomes need actual browser oracles']},
 {family:'personnel-draft',allocation:'new-nonemployment-job-owned-draft',
  principalOwner:'lib/session.ts:resolveWorkosPrincipal/withEntitlements + lib/internal-auth/service.ts:readSession',
  nativeOwners:['core/employee-draft.ts:createEmployeeDraftWithReservedCode','core/employee-draft.ts:getEmployeeDraft','core/employee-draft.ts:saveEmployeeDraft'],
  expectedInputOwner:'navigationV3DraftInput + current native employee ID rule + canonical returned reserved code',
  missing:['manual not permitted / missing canonical grant means blocked; never change native numbering rule','getEmployeeDraft has no enclosing Tx; constructor has separate current rule read then command','new route unknown draft can render Create: cannot infer 404 or denial from HTTP200','unsaved cancel/discard must produce zero save events; saved reopen must use canonical server action and independent reread','constructor/reservation/discard cleanup native history and no employment/payroll changes must be proven']},
]);
