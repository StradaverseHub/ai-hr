/** Per-tool explanation evidence for the actual Assistant source owner. This helper does not prove
 * caller authority, a promotion or source freshness: the real tool carrier/replay must do that first.
 * A model/browser/historical JSON object is never an authorized replacement for the actual outcome.
 * Re-execution here uses ONLY the selected canonical playbook already stamped on that outcome. It
 * must reproduce the entire compact work; otherwise fail, rather than silently fall back to baseline.
 */
import {isDeepStrictEqual} from 'node:util';
import {isAgentModuleCode} from './module-agents';
import {SpecialistCandidate,executeCanonicalSpecialist,compactSpecialistWork} from './module-specialists';
import {presentGroundedToolOutcome,type GroundedToolName} from './grounded-tool-presentation';
import {leaveAnswerExplanations,specialistAnswerExplanations,type AssistantAnswerExplanation} from './assistant-answer-explanations';
import type {JobPresentation} from './module-jobs';
const fail=():never=>{throw Error('Assistant tool explanation evidence unavailable.');};
function record(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
 for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')return fail();const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)return fail();}
 return value as Record<string,unknown>;
}
function keys(row:Record<string,unknown>,expected:readonly string[]):void{if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key)))return fail();}

/** No unknown-tool generic cause/explanation. Actual lease/role/source guards remain in the owner. */
export function assistantToolAnswerExplanations(name:GroundedToolName,outcome:unknown,presentation:JobPresentation):readonly AssistantAnswerExplanation[]{
 try{return checkedToolAnswerExplanations(name,outcome,presentation);}catch{return fail();}
}
function checkedToolAnswerExplanations(name:GroundedToolName,outcome:unknown,presentation:JobPresentation):readonly AssistantAnswerExplanation[]{
 if(name==='leave_entitlement_explain')return leaveAnswerExplanations(outcome,presentation);
 if(name!=='my_module_work')return Object.freeze([]);
 const source=record(outcome);keys(source,['ok','module','capability','scope','data','specialistWork',...(Object.hasOwn(source,'humanActions')?['humanActions']:[])]);
 if(source.ok!==true||!isAgentModuleCode(source.module)||source.scope!=='current-caller'||typeof source.capability!=='string')return fail();
 const work=record(source.specialistWork);
 // Construct only the closed existing configuration; every selected field must also match the
 // independently reconstructed compact work below, including digest/version/mode/diagnostic.
 const configuration=SpecialistCandidate.parse({kind:'canonical_specialist_v1',module:source.module,playbook:work.playbook});
 if(work.mode!=='baseline'&&work.mode!=='promoted'||typeof work.candidateVersion!=='number')return fail();
 const assessment=executeCanonicalSpecialist(configuration,{module:source.module,capability:source.capability,scope:source.scope,data:source.data,
  ...(Object.hasOwn(source,'humanActions')?{humanActions:source.humanActions}:{})});
 const expected=compactSpecialistWork(assessment,{mode:work.mode,version:work.candidateVersion,configuration});
 if(!isDeepStrictEqual(expected,work))return fail();
 // Exact full presentation also validates actual human handoffs and fixes original source-card
 // positions. The specialist bridge separately checks the assessment's base presentation prefix.
 const shown=presentGroundedToolOutcome(name,source);
 if(!shown||!isDeepStrictEqual(shown,presentation))return fail();
 return specialistAnswerExplanations(assessment,presentation);
}
