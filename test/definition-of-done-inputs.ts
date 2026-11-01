/** Step 5c — the live inputs of the definition of done (core/improvement/definition-of-done.ts), gathered from
 * the registries, the semantic model, the bundled guides, the setup co-pilot and every evaluation corpus.
 * Under test/ because the corpora are evaluation-only. No database: imports and file reads only. */
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {loadGuides} from '../lib/guide-catalog';
import {SEMANTIC_ACTIONS,SEMANTIC_READS} from '../core/semantic-model/entities';
import {TERAS_READS,terasEntity} from '../core/semantic-model/generate';
import {SETUP_STAGES} from '../core/semantic-model/entities-setup';
import {CLAIMS_GAP} from '../core/setup-copilot/copilot';
import type {DoneInputs} from '../core/improvement/definition-of-done';
import {ASSISTANT_COMPLEX_BASELINE,ASSISTANT_PARITY_ACTIONS,ASSISTANT_PRODUCTION_BASELINE,type BaselineConversation} from './assistant-production-baseline-corpus';
import {EXPLAINER_CONVERSATIONS} from './explainer-corpus';
import {SENSITIVE_CORPUS} from './harness-sensitive-corpus';

/** A module's go-live stage: `<module>_setup` where the co-pilot has one; payroll's is company_payroll_setup. */
export function moduleStages():ReadonlyMap<string,string>{
 const stages:readonly string[]=SETUP_STAGES,modules=new Set([...AGENT_ACTIONS.map(action=>action.module as string),...LINKABLE_PAGES.flatMap(([,,module])=>module?[module]:[])]);
 return new Map([...modules].flatMap(module=>module==='payroll'?[[module,'company_payroll_setup'] as const]:stages.includes(module+'_setup')?[[module,module+'_setup'] as const]:[]));
}
export function definitionOfDoneInputs():DoneInputs{
 const reads=[...SEMANTIC_READS,...TERAS_READS],conversations:readonly BaselineConversation[]=[...ASSISTANT_PRODUCTION_BASELINE,...ASSISTANT_COMPLEX_BASELINE,...ASSISTANT_PARITY_ACTIONS,...EXPLAINER_CONVERSATIONS];
 return{
  actions:AGENT_ACTIONS.map(action=>({id:action.id,module:action.module,reviewRoute:action.review.route,nativeScreen:action.screen.native,evaluationCases:action.evaluationCases.map(row=>row.case)})),
  pages:LINKABLE_PAGES.map(([path,,module])=>({path,module})),
  semanticActions:new Set(SEMANTIC_ACTIONS.map(action=>action.id)),
  semanticPages:new Set([...reads.map(read=>terasEntity(read.entity).page),...SEMANTIC_ACTIONS.map(action=>action.reviewRoute)]),
  readPages:new Map(reads.map(read=>[read.name,terasEntity(read.entity).page])),
  guideBodies:loadGuides().map(guide=>guide.body),
  moduleStages:moduleStages(),stagesWithoutOwner:new Set([CLAIMS_GAP.area]),
  corpus:[...conversations.flatMap(conversation=>conversation.turns.map(turn=>({id:turn.id,conversation:conversation.id,ideal:turn.ideal}))),
   ...SENSITIVE_CORPUS.map(turn=>({id:turn.id,conversation:'sensitive',ideal:{mode:turn.expect==='open'?'answer':'refuse'}}))],
 };
}
