import {AiPrivacyGateError} from '../lib/ai/provider-privacy-request';
/**
 * ADR-0082 slice 3 — THE LOOP. The caller that finally joins `converse()` (r221) to the tool registry
 * (r223), which have existed side by side with nothing between them since 2026-08-26.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT DELIBERATELY IS NOT.
 * It owns the exchange: the budget gate, the turn loop, tool dispatch, and the audit row. It owns no
 * authorization of its own — every tool runs inside the CALLER's `SessionContext`, so RLS and ABAC scope
 * the reads exactly as they scope the screens (§2.3, and the reason there is no new access control here).
 * It computes nothing: the model never sees a figure this file derived, only what a wrapped `core/read`
 * returned to the caller's own session.
 *
 * THE FIVE THINGS THAT ARE EASY TO GET WRONG HERE, EACH LEARNED FROM THE ADR OR FROM r223:
 *
 *  1. THE BUDGET IS RESERVED BEFORE SPENDING AND AT EVERY PROVIDER ADMISSION. A per-call timeout does not bound a
 *     loop and neither does a single up-front check: eight turns of a runaway question would overshoot a
 *     monthly ceiling by the size of its own loop. §2.6.
 *  2. EVERY TOOL CALL RETURNS A RESULT. A dropped result is not a smaller answer, it is a malformed
 *     conversation — the provider correlates by id (and Google by NAME, which is why AiToolResult carries
 *     both). An unknown tool, unparseable arguments and a thrown wrapper all come back as `isError`.
 *  3. A REFUSAL IS NOT AN ERROR. `{ ok: false, refusal }` is a tool working correctly and declining; it
 *     goes back as ordinary content so the model can say "you can't see that", not as `isError`, which
 *     would invite a retry. A THROWN exception is the error case.
 *  4. STOPPING IS ALWAYS VISIBLE. `max_tokens`, `refusal`, `other` and the turn cap are all terminal AND
 *     recorded. An assistant that quietly stops looking is indistinguishable from one that finished
 *     (§2.5) — the same discipline ADR-0076 §2.4 applies to a skipped detector.
 *  5. THE AUDIT ROW HOLDS INPUTS AND COUNTS, NEVER ROWS. `tool_calls` records what was asked for and how
 *     much came back. Persisting the tool OUTPUT would copy payslip and identity data into a table with
 *     a different retention story from the one it came out of (§2.7, ADR-0030).
 *
 * THE SYSTEM PROMPT AND THE CACHE KEY MUST STAY STABLE. The cacheable prefix is `tools` + `system`, so a
 * single volatile byte — a clock value, a locale, a user id, anything tenant-shaped — invalidates the
 * prefix for every later request and quietly multiplies the cost of the feature. Both are built from
 * constants plus the authorized catalogue and the caller’s versioned conversation strategy. Read the comment on SYSTEM before adding a line to it.
 */
import { randomUUID } from 'node:crypto';
import { assistantSourceDigest, sealAssistantDisclosure, type AssistantSourceRead } from '../lib/ai/assistant-disclosure';
import { ownAssistantClarification, assertOwnAssistantClarificationCurrentTx, assistantClarificationSourceExchangeId,assistantClarificationThreadId } from './assistant-clarification';
import {ownAssistantConversationContext,assertOwnAssistantConversationContextCurrentTx,assistantConversationSourceExchangeId,issueAssistantConversationToken,assistantConversationScopeDigest,assistantConversationThreadId} from './assistant-conversation-context';
import {ASSISTANT_PRIVATE_CONTRACT,resolvePrivateAssistantIntent,resolvePrivateAssistantProposal,privateAssistantCatalogue,adjudicatePrivateAssistantTerminal,resolvePrivateAssistantClarifiedIntent,selectPrivateAssistantCards,type PrivateAssistantLocalEmployment} from '../lib/ai/provider-assistant-policy';
import {preparePrivateAiTask} from './ai-governance';
import {todayInKualaLumpur} from '../lib/hr-date';
import {resolveEntitlementsTx} from './entitlements';
import {withAssistantAdmissionReadsTx} from './assistant-read-session';
import {assistantSourceReplay} from './assistant-disclosure-read';
import {prepareAssistantConversationStrategyTx,completeAssistantConversationStrategyTx,retireAssistantConversationStrategyCapability,readGovernedSpecialistToolResultTx,type AssistantConversationStrategyCapability} from './module-agent-releases';
import { adjudicateAssistantAnswerPlan, type AssistantAnswerPlan, type AssistantAnswerRead } from '../lib/ai/assistant-answer-plan';
import { assistantToolAnswerExplanations } from '../lib/ai/assistant-tool-answer-evidence';
import { assistantAnswerExplanationAvailability } from '../lib/ai/assistant-answer-explanations';
import { isGroundedToolName, presentGroundedToolOutcome } from '../lib/ai/grounded-tool-presentation';
import { sql } from 'drizzle-orm';
import { captureAgentReadBatch, serializeAgentReadResult } from '../lib/ai/agent-read-batch';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { assistantExchange, assistantUsage } from '../db/schema';
import { converse } from '../lib/ai';
import { AiAllowanceError,AiGatewayError, type AiStop, type AiToolCall, type AiToolResult, type AiUsage } from '../lib/ai/types';
import { resolveActiveAiConfig } from './ai-config';
import {bindAiSpendTaskTx} from './ai-spend-task';
import {assistantQuestionBudgetBinding,AssistantQuestionBudgetError,completeAssistantQuestionBudgetTx,type AssistantQuestionBudget} from './assistant-question-budget';
import { assertMayUseAssistant } from './assistant-grant';
import { withAssistantRead,type AssistantReadSession } from './assistant-read-session';
import {withGovernedSpecialistReadBatch} from './module-agent-releases';
import {isAgentModuleCode,type AgentModuleCode} from '../lib/ai/module-agents';
import { ASSISTANT_PUBLIC_REPLIES, assistantPublicToolResult } from '../lib/ai/assistant-public-replies';
import { ASSISTANT_TOOLS, toolsFor,specsFor, type AssistantTool, type ToolOutcome } from './assistant-tools';
import { assistantReadableModules } from './assistant-readable-modules';

/**
 * §2.5 fixes this at 8: enough for a genuinely multi-part question ("who on my team is on leave next
 * week and what are their balances" — one tool to list the team, one per balance) while a loop cannot
 * run away. Exported because the test asserts the cap is REACHED, not that some number is stored.
 */
export const MAX_TURNS = 8;

/**
 * The whole-exchange ceiling, distinct from the gateway's per-round-trip `timeoutMs`. Eight turns each
 * allowed 120s would be twenty minutes of a held request; this bounds the exchange rather than the call,
 * which is the gap `ConverseArgs.timeoutMs`'s own comment points at.
 */
export const EXCHANGE_DEADLINE_MS = 90_000;

/** One provider round trip's ceiling, kept well inside EXCHANGE_DEADLINE_MS so a single slow turn cannot
 *  consume the whole exchange and leave nothing for the answer. */
const TURN_TIMEOUT_MS = 30_000;

export type AssistantErrorCode =
  /** No AI provider is configured for this tenant (ADR-0023 BYOK). */
  | 'not_configured'
  /** The tenant's monthly token ceiling is spent. */
  | 'budget_monthly'
  /** This user has asked their allowance of questions today. */
  | 'budget_daily'
  /** The question was empty or longer than the assistant will accept. */
  | 'invalid_question'
  /** The provider failed. The detail is deliberately NOT carried to the caller. */
  | 'provider_error'
  | 'protected_input'
  /** A shared feature, company or user AI control refused the request. */
  | 'ai_control';

export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(`assistant:${code}`);
    this.name = 'AssistantError';
  }
}

/** Submission metadata only. Raw model prose stays in audit custody; display consumers must reopen
 * the exchange through current canonical grounding, rather than treating a model reply as HR truth. */
export type AssistantAnswer = {
  exchangeId: string;
  stop: AiStop;
  /** Provider round trips actually made. */
  turns: number;
  /** True when MAX_TURNS was reached with the model still asking for tools. §2.5: visible, not silent. */
  hitTurnCap: boolean;
  /** Names only, in call order, for a "what did it look at" line under the answer. */
  toolsUsed: string[];
  /** Opaque scope-bound continuation proof, held only by the current chat client. */
  conversationToken?:string;
};

/**
 * A question is bounded before it reaches a provider. 2,000 characters is far past any real question and
 * far short of a pasted document — the assistant reads the tenant's data through tools, so a large body
 * of text in the question is either a mistake or an injection attempt (§2.4).
 */
const MAX_QUESTION_CHARS = 2000;


/** Every registered name — consulted ONLY to label an audit refusal, never to resolve a call. */
const ASSISTANT_TOOL_NAMES: ReadonlySet<string> = new Set(ASSISTANT_TOOLS.map((t) => t.spec.name));

/**
 * How much a tool returned, for the audit row. The first array-valued property is the payload on every
 * tool in the registry (`{ ok: true, balances: [...] }`), so its length is the honest count; a scalar
 * answer records null rather than a misleading 1.
 */
function rowCountOf(outcome: ToolOutcome): number | null {
  if (!outcome.ok) return null;
  for (const v of Object.values(outcome)) if (Array.isArray(v)) return v.length;
  return null;
}

/**
 * Ask the assistant one question and return its recorded exchange metadata.
 *
 * `now` controls the bounded exchange deadline. Quota days and periods come from the database's
 * Malaysia business clock at the native question reservation, never from caller-supplied dates.
 */
export async function askAssistant(
  ctx: SessionContext,
  p: { question: string; now?: Date; clarificationExchangeId?:string; previousExchangeId?:string; previousConversationToken?:string; conversationScope?:string },
): Promise<AssistantAnswer> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  p={question:p.question,...(p.now?{now:new Date(p.now.getTime())}:{}),...(p.clarificationExchangeId===undefined?{}:{clarificationExchangeId:p.clarificationExchangeId}),...(p.previousExchangeId===undefined?{}:{previousExchangeId:p.previousExchangeId}),...(p.previousConversationToken===undefined?{}:{previousConversationToken:p.previousConversationToken}),...(p.conversationScope===undefined?{}:{conversationScope:p.conversationScope})};
  // The grant is the gate, and it is checked before anything else — including before we look at whether
  // the tenant even has a provider, so an ungranted user cannot probe the configuration.
  await assertMayUseAssistant(ctx);
  // NOT a second gate: mayUseAssistant already refuses a context with no app_user ('no_user'), so this
  // branch is unreachable. It exists to narrow `SessionContext.userId?: string` for the two NOT NULL
  // columns below — the alternative is a non-null assertion, which would survive a future reordering
  // that moved the grant check and lose the guarantee silently.
  const appUserId = ctx.userId;
  if (!appUserId) throw new AssistantError('invalid_question');

  const humanQuestion = p.question.trim();
  if (!humanQuestion || humanQuestion.length > MAX_QUESTION_CHARS || (p.conversationScope!==undefined&&(typeof p.conversationScope!=='string'||p.conversationScope.length>4096))) throw new AssistantError('invalid_question');
  if((p.previousExchangeId===undefined)!==(p.previousConversationToken===undefined))throw new AssistantError('invalid_question');
  if(p.clarificationExchangeId!==undefined&&p.previousExchangeId!==undefined)throw new AssistantError('invalid_question');
  const conversationContext=p.previousExchangeId===undefined?null:await ownAssistantConversationContext(ctx,p.previousExchangeId,humanQuestion,p.previousConversationToken,p.conversationScope).catch(()=>{throw new AssistantError('invalid_question');});
  const clarification = p.clarificationExchangeId===undefined?null:await ownAssistantClarification(ctx,p.clarificationExchangeId,humanQuestion,p.conversationScope);
  const threadId=assistantClarificationThreadId(clarification)??assistantConversationThreadId(conversationContext);
  // 0658: the new row records which own exchange it answered, so a later reply can carry this one too.
  const continuesExchangeId = assistantClarificationSourceExchangeId(clarification)??assistantConversationSourceExchangeId(conversationContext);
  // This private callback closes over the authenticated owner-issued handle, never a posted ID.
  // Retention/custody is rechecked again in the content transaction after provider latency.
  const continuationCheck:((tx:Tx)=>Promise<void>)|undefined=clarification?tx=>assertOwnAssistantClarificationCurrentTx(tx,ctx,clarification):
    conversationContext?tx=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,conversationContext):undefined;
  // Stored history is human-readable. Each continuation is loaded by the actual own-row owner,
  // and only human text enters context; no prior model answer or historical HR result is replayed.
  // RETENTION (owner rule: raw chat content lives 30 days from ITS OWN question). A continuation stores
  // ONLY the new human question. The original question stays in the original exchange under that exchange's
  // deadline and reaches the provider below as transient turn context; copying it into this new row would
  // give it a fresh 30 days, so a clarification read on day 29 would carry it to day 59.
  const question = humanQuestion;

  const now = p.now ?? new Date();
  const deadline = now.getTime() + EXCHANGE_DEADLINE_MS;

  const { cfg, period, reservation, conversationStrategy } = await withTenant(ctx, async (tx) => {
    const cfg = await resolveActiveAiConfig(tx, ctx, 'hr_assistant');
    if (!cfg) throw new AssistantError('not_configured');
    // Persist a new human-question intent BEFORE provider work. Its root is held in the issued
    // configuration through every converse/tool step; no late completed exchange ID or prompt hash.
    const rooted=await bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'});
    const budget=assistantQuestionBudgetBinding(ctx,rooted);
    // A continuation's original question is transient provider context read in its own earlier
    // transaction. The strategy owner rechecks that own source exchange in this marker transaction and
    // before every provider round trip, so history erased or retired since that read never reaches one.
    const conversationStrategy=await prepareAssistantConversationStrategyTx(tx,ctx,rooted,question,
      continuationCheck);
    return { cfg:conversationStrategy.configuration, conversationStrategy, ...budget };
  }).catch(error=>{
    if(error instanceof AssistantQuestionBudgetError)throw new AssistantError(error.budgetCode);
    throw error;
  });

  // Token, request, concurrency and time controls remain mandatory at provider admission.
  // Any configured USD cap additionally requires verified monetary allocation; no cap promises no USD ceiling.

  // ONE list, computed once: what the model is offered and what dispatch may run are the same array, so
  // a tool outside the tenant's modules cannot be reached by the model simply naming it.
  const offered = toolsFor(ctx);
  const tools = offered.map((t) => t.spec);
  // Own-row context is interpreted only by the closed LOCAL grammar. Human wording, prior
  // answers, tenant labels and provider continuation state never enter a provider request.
  const localHistory=clarification?[...clarification.earlier.map(step=>step.question),clarification.originalQuestion]:conversationContext?.questions??[];
  const intent=clarification?resolvePrivateAssistantClarifiedIntent(clarification):resolvePrivateAssistantIntent(humanQuestion,localHistory);
  const proposal=resolvePrivateAssistantProposal(humanQuestion);
  const audit: { name: string; input: unknown; rowCount: number | null; refusal?: string }[] = [];

  const sourceReads: AssistantSourceRead[] = [];
  let sourcesComplete = true;
  let answer = '';
  let answerPlan: AssistantAnswerPlan | undefined;
  const answerReads: AssistantAnswerRead[] = [];
  let stop: AiStop = 'other';
  let turnCount = 0;
  let hitTurnCap = false;
  const spend: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let failure: string | null = null;

  try {
    if(Date.now()>=deadline)throw new AssistantError('provider_error');
    if(intent.social){answerPlan=adjudicateAssistantAnswerPlan({version:1,mode:'social',code:intent.social},[],{question:humanQuestion});stop='end';answer=JSON.stringify(answerPlan);}
    else if(proposal){answerPlan=adjudicateAssistantAnswerPlan({version:1,mode:'propose',action:proposal.action,hints:proposal.hints},[],{question:humanQuestion,readableModules:assistantReadableModules(ctx)});stop='end';answer=JSON.stringify(answerPlan);}
    else if(!intent.intent){answerPlan={version:1,mode:'clarify',slot:clarification?.slot??'module'};stop='end';answer=JSON.stringify(answerPlan);}
    else if(intent.intent==='pay_change'){answerPlan=adjudicateAssistantAnswerPlan({version:1,mode:'insufficient',code:'unsupported_explanation'},[],{question:humanQuestion});stop='end';answer=JSON.stringify(answerPlan);}
    else{
      // These server-owned own-subject calls are the only local read plan for the recognized intent.
      // No model-supplied argument, person identity, tool name or output can nominate another read.
      const module=intent.module;if(!module)throw new AssistantError('invalid_question');
      const selected:readonly {name:string;input:Record<string,unknown>}[]=intent.intent==='leave_available'||intent.intent==='leave_pending'||intent.intent==='leave_taken'?[{name:'my_leave_balances',input:{}}]:
        intent.intent==='leave_requests'?[{name:'my_leave_requests',input:{limit:10}}]:intent.intent==='claim_statuses'?[{name:'my_claim_statuses',input:{limit:10}}]:
        intent.intent==='holidays'?[{name:'upcoming_holidays',input:{from:intent.fromDate??todayInKualaLumpur(),limit:10}}]:intent.intent==='reporting_line'?[{name:'my_reporting_line',input:{}}]:
        intent.intent==='payslip'?[{name:'my_payslip_summary',input:{limit:clarification?.slot==='period'||clarification?.earlier.some(step=>step.slot==='period')?12:1}}]:[{name:'my_module_work',input:{module}}];
      const calls=selected.map((call,index)=>({id:`local-read-${index}`,name:call.name,input:call.input}));
      const results=await runTools(ctx,offered,calls,audit,sourceReads,randomUUID());
      if(results.some(result=>result.isError))sourcesComplete=false;
      const localEmployments:PrivateAssistantLocalEmployment[]=[];
      let ordinal=0;
      for(const result of results){if(result.isError)continue;const read=ordinal++;try{if(!isGroundedToolName(result.name))continue;const outcome=JSON.parse(result.content),presentation=presentGroundedToolOutcome(result.name,outcome);if(presentation&&read<8){answerReads.push(Object.freeze({read,presentation,explanations:assistantAnswerExplanationAvailability(assistantToolAnswerExplanations(result.name,outcome,presentation))}));
        // Identity grouping remains local and comes from this exact successful own-subject source.
        // Multiple own employments with the same company label remain ambiguous, never merged.
        if(result.name==='my_leave_balances'&&Array.isArray(outcome.employments)){let card=0;for(const employment of outcome.employments){if(!employment||typeof employment!=='object'||!Array.isArray(employment.balances))continue;for(const _balance of employment.balances){if(card<presentation.cards.length&&typeof employment.employmentId==='string'&&typeof employment.company==='string')localEmployments.push({read,card,key:employment.employmentId,labels:[employment.company]});card++;}}}
      }}catch{/* No unsupported source acquires answer authority. */}}
      if(!sourcesComplete)throw new AssistantError('provider_error');
      const selectedCards=selectPrivateAssistantCards(intent.intent,answerReads,clarification,localEmployments);
      const catalogue=privateAssistantCatalogue(intent.intent,answerReads,conversationStrategy.variant,selectedCards.selection);
      const hasReferences=catalogue.operation==='conversation'&&catalogue.reads.some(read=>read.explanations.length||read.cards.some(card=>card.facts.some(fact=>fact.available)));
      if(selectedCards.slot){answerPlan={version:1,mode:'clarify',slot:selectedCards.slot};stop='end';answer=JSON.stringify(answerPlan);}
      else if(!hasReferences){answerPlan=adjudicateAssistantAnswerPlan({version:1,mode:'insufficient',code:'no_verified_facts'},answerReads,{question:humanQuestion});stop='end';answer=JSON.stringify(answerPlan);}
      else{
        const prepared=await preparePrivateAiTask(cfg,ASSISTANT_PRIVATE_CONTRACT,async(tx,current)=>{
          if(Date.now()>=deadline)throw new AiGatewayError('The current Assistant source access could not be confirmed.');
          const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
          if(JSON.stringify(specsFor(fresh))!==JSON.stringify(tools))throw new AiGatewayError('The current Assistant tools changed.');
          const valid=await withAssistantAdmissionReadsTx(fresh,tx,session=>assistantSourceReplay(fresh,session,async source=>{
            const input=source.input&&typeof source.input==='object'&&!Array.isArray(source.input)?source.input as Record<string,unknown>:null;
            if(source.name!=='my_module_work'||!source.moduleJobId||!input||Object.keys(input).length!==1||!isAgentModuleCode(input.module))throw new AiGatewayError('The current Assistant source access could not be confirmed.');
            return(await readGovernedSpecialistToolResultTx(tx,fresh,source.moduleJobId,input.module)).outcome;
          })(sourceReads));
          if(!valid||Date.now()>=deadline)throw new AiGatewayError('The current Assistant source access could not be confirmed.');
          // Full canonical fingerprints above replay even if masked reference metadata is equal.
          return catalogue;
        });
        try{
          if(prepared.operation!=='conversation')throw new AssistantError('provider_error');
          const res=await converse(prepared.configuration,prepared.args);turnCount++;
          spend.inputTokens+=res.usage.inputTokens;spend.outputTokens+=res.usage.outputTokens;spend.cachedInputTokens+=res.usage.cachedInputTokens;stop=res.stop;
          // Model text/state never returns to a provider. It may nominate only this request's closed
          // available references; the existing canonical adjudicator checks their current meaning.
          answer=res.text;
          // Preserve terminal refusal/truncation/unknown feedback and observed usage. A model asking
          // for tools it was never offered receives a truthful non-answer; no call is dispatched.
          if(res.toolCalls.length||res.stop==='tool_use')stop='other';
          if(stop==='end')try{answerPlan=adjudicateAssistantAnswerPlan(adjudicatePrivateAssistantTerminal(res.text,prepared.local),answerReads,{question:humanQuestion,readableModules:assistantReadableModules(ctx)});}catch{answerPlan=undefined;}
          // Raw text remains audit-only under the existing custody/retention owner. Canonical display
          // needs the adjudicated plan; no failed model output is silently relabelled a valid answer.
        }finally{prepared.dispose();}
      }
    }

  } catch (e) {
    if (e instanceof AssistantQuestionBudgetError) {
      await persist(ctx, { threadId,conversationScope:p.conversationScope,continuationCheck, reservation, strategy:conversationStrategy.capability, continuesExchangeId, appUserId, question, answer: '', audit, turnCount, hitTurnCap, stop, cfg, spend, period, error:e.budgetCode });
      throw new AssistantError(e.budgetCode);
    }
    if (e instanceof AiAllowanceError) {
      await persist(ctx, { threadId,conversationScope:p.conversationScope,continuationCheck, reservation, strategy:conversationStrategy.capability, continuesExchangeId, appUserId, question, answer: '', audit, turnCount, hitTurnCap, stop, cfg, spend, period, error: 'ai_control' });
      throw new AssistantError('ai_control');
    }
    if(e instanceof AiPrivacyGateError){await persist(ctx,{threadId,conversationScope:p.conversationScope,continuationCheck,reservation,strategy:conversationStrategy.capability,continuesExchangeId,appUserId,question,answer:'',audit,turnCount,hitTurnCap,stop,cfg,spend,period,error:'protected_input'});throw new AssistantError('protected_input');}
    if (e instanceof AssistantError) {
      // A budget refusal mid-loop still records what was spent getting there.
      failure = e.code;
      await persist(ctx, { threadId,conversationScope:p.conversationScope,continuationCheck, reservation, strategy:conversationStrategy.capability, continuesExchangeId, appUserId, question, answer: '', audit, turnCount, hitTurnCap, stop, cfg, spend, period, error: e.code });
      throw e;
    }
    failure = 'provider_error';
    await persist(ctx, { threadId,conversationScope:p.conversationScope,continuationCheck, reservation, strategy:conversationStrategy.capability, continuesExchangeId, appUserId, question, answer: '', audit, turnCount, hitTurnCap, stop, cfg, spend, period, error: failure });
    throw new AssistantError('provider_error');
  }

  // From here the question is ADMITTED: it counts against the allowance exactly once whatever happens.
  const recorded = await persist(ctx, {
    threadId,conversationScope:p.conversationScope,
    continuationCheck,
    reservation,
    strategy:conversationStrategy.capability,
    continuesExchangeId,
    appUserId,
    question,
    answer,
    audit,
    turnCount,
    hitTurnCap,
    stop,
    cfg,
    spend,
    period,
    error: failure,
    sourceReads: sourcesComplete ? sourceReads : undefined,
    answerPlan,
  });
  // Content withdrawn mid-flight (history cleared, erasure, access change): accounting was recorded, the
  // answer was not. The caller sees the generic, warm failure and nothing that confirms what was erased.
  if (!recorded.retained) throw new AssistantError('provider_error');

  return { exchangeId: recorded.exchangeId, conversationToken:issueAssistantConversationToken(ctx,recorded.exchangeId,conversationContext,p.conversationScope), stop, turns: turnCount, hitTurnCap, toolsUsed: audit.map((a) => a.name) };
}

/**
 * Execute one bounded model batch sequentially in a single caller-owned read transaction.
 * Every canonical query uses that same connection and source authority boundary.
 * Result order remains the request order. No provider call happens inside this transaction.
 */
async function runTools(
 ctx:SessionContext,offered:readonly AssistantTool[],supplied:readonly AiToolCall[],
 audit:{name:string;input:unknown;rowCount:number|null;refusal?:string}[],sourceReads:AssistantSourceRead[],nonce:string,
):Promise<AiToolResult[]>{
 const calls=captureAgentReadBatch(supplied),modules:AgentModuleCode[]=[];
 for(const call of calls){if(call.name!=='my_module_work'||!offered.some(tool=>tool.spec.name===call.name)||!call.input||typeof call.input!=='object'||Array.isArray(call.input))continue;const input=call.input as Record<string,unknown>;
  if(Object.keys(input).length===1&&isAgentModuleCode(input.module)&&!modules.includes(input.module))modules.push(input.module);
 }
 const observations:{name:string;input:unknown;rowCount:number|null;refusal?:string}[]=[],reads:AssistantSourceRead[]=[];
 const consume=async(session:AssistantReadSession)=>{const results:AiToolResult[]=[];for(const call of calls){const result=await(async():Promise<AiToolResult>=>{
  const tool=offered.find(row=>row.spec.name===call.name);
  if(!tool){observations.push({name:call.name,input:call.input,rowCount:null,refusal:ASSISTANT_TOOL_NAMES.has(call.name)?'not_offered':'unknown_tool'});return{id:call.id,name:call.name,content:ASSISTANT_PUBLIC_REPLIES.tool,isError:true};}
  if(call.input===undefined){observations.push({name:call.name,input:null,rowCount:null,refusal:'unparseable_input'});return{id:call.id,name:call.name,content:ASSISTANT_PUBLIC_REPLIES.arguments,isError:true};}
  // No per-tool catch inside the carrier: a storage/partial-reservation error MUST unwind the
  // complete source transaction before any bounded reply or source evidence can be returned.
  const outcome=await tool.run(ctx,call.input,session),publicOutcome=assistantPublicToolResult(outcome),content=serializeAgentReadResult(publicOutcome);
  reads.push(Object.freeze({name:call.name,input:call.input,digest:assistantSourceDigest(publicOutcome)}));
  observations.push({name:call.name,input:call.input,rowCount:rowCountOf(outcome),...(outcome.ok?{}:{refusal:outcome.refusal})});return{id:call.id,name:call.name,content};
 })();results.push(result);}return results;};
 try{
  const batch=modules.length?await withGovernedSpecialistReadBatch(ctx,{version:1,modules},{nonce},consume):{jobId:null,value:await withAssistantRead(ctx,null,consume)};
  audit.push(...observations);sourceReads.push(...reads.map(row=>{const input=row.input&&typeof row.input==='object'&&!Array.isArray(row.input)?row.input as Record<string,unknown>:null;return row.name==='my_module_work'&&batch.jobId&&input&&Object.keys(input).length===1&&isAgentModuleCode(input.module)?Object.freeze({...row,moduleJobId:batch.jobId}):row;}));return batch.value;
 }catch{
  // This boundary is AFTER rollback. Failed/cancelled work never becomes a verified source read.
  audit.push(...calls.map(call=>({name:call.name,input:call.input??null,rowCount:null,refusal:'tool_error'})));
  return calls.map(call=>({id:call.id,name:call.name,content:ASSISTANT_PUBLIC_REPLIES.lookup,isError:true}));
 }
}

type PersistInput = {
  /** Scope uses the one existing context owner; a genuine parent alone supplies inherited identity. */
  threadId?:string;conversationScope?:string;
  /** Private same-Tx custody fence; never serialized or stored. Undefined for a genuinely new chat. */
  continuationCheck?: (tx:Tx)=>Promise<void>;
  reservation:AssistantQuestionBudget;
  strategy:AssistantConversationStrategyCapability;
  appUserId: string;
  question: string;
  answer: string;
  audit: { name: string; input: unknown; rowCount: number | null; refusal?: string }[];
  turnCount: number;
  hitTurnCap: boolean;
  stop: AiStop;
  cfg: { provider: string; model: string };
  spend: AiUsage;
  period: string;
  error: string | null;
  sourceReads?: readonly AssistantSourceRead[];
  answerPlan?: AssistantAnswerPlan;
  /** The own exchange this one answered (0658); the guard refuses anything else. */
  continuesExchangeId?: string | null;
};

/** `retained` is false when the exchange's raw content could not be kept; its accounting still was. */
type RecordedExchange = Readonly<{ exchangeId: string; retained: boolean }>;

/**
 * Record ONE ADMITTED question. Called exactly once per admission, on every outcome (answer, refusal,
 * provider failure), and it always leaves exactly one accounting row and one usage increment behind.
 *
 * WHY TWO TRANSACTIONS. The content transaction completes the strategy-use marker, which is how history
 * clearing and PDPA erasure fence in-flight work: an erased marker makes completion refuse, and the whole
 * content transaction rolls back so erased raw text is never recreated. Before this split that rollback
 * also took the exchange row (the per-user daily COUNTER) and the period usage with it, so "ask, clear
 * history mid-flight, repeat" walked past the daily ceiling and spent provider tokens that were never
 * counted. The fallback records the same exchange id with its content already retired — counts, tokens,
 * provider and dates only — plus the usage, in one transaction. ON CONFLICT on that id makes a lost commit
 * acknowledgement harmless: if the content transaction did commit, the fallback inserts nothing and adds
 * no usage, so nothing is counted twice.
 */
async function persist(ctx: SessionContext, p: PersistInput): Promise<RecordedExchange> {
  const id = randomUUID();
  try {
    try {
      await persistWithContent(ctx, id, p);
      return Object.freeze({ exchangeId: id, retained: true });
    } catch {
      // Deliberately undiagnosed: erasure, revoked access, a lock timeout and a storage fault all end the
      // same way — no raw content, full accounting. A failure here is never shown to the caller.
    }
    const inserted = await persistAccountingOnly(ctx, id, p);
    // No insert means the content transaction's commit landed after all; that row is the whole record.
    return Object.freeze({ exchangeId: id, retained: !inserted });
  } finally {
    // The request is finished either way; a pending DB marker that was not completed stays refused.
    retireAssistantConversationStrategyCapability(p.strategy);
  }
}

/** The exchange with its content, the strategy completion and the usage, in ONE transaction so usage can
 *  never be recorded without the exchange that caused it. */
async function persistWithContent(ctx: SessionContext, id: string, p: PersistInput): Promise<void> {
  const disclosureReceipt = sealAssistantDisclosure({ tenantId: ctx.tenantId, userId: p.appUserId,
    exchangeId: id, question: p.question, answer: p.answer }, p.sourceReads, p.answerPlan,{threadId:p.threadId??id,scopeDigest:assistantConversationScopeDigest(ctx,p.conversationScope)});
  await withTenant(ctx, async (tx) => {
    // Keep the owner Access interval through INSERT + marker completion + accounting COMMIT.
    // A source erased during the sole provider call must never acquire fresh retained content.
    if(p.continuationCheck)await p.continuationCheck(tx);
    const [row] = await tx
      .insert(assistantExchange)
      .values({
        tenantId: ctx.tenantId,
        appUserId: p.appUserId,
        id,
        question: p.question,
        answer: p.answer || null,
        disclosureReceipt,
        toolCalls: p.audit,
        turnCount: p.turnCount,
        hitTurnCap: p.hitTurnCap,
        stop: p.stop,
        provider: p.cfg.provider,
        model: p.cfg.model,
        inputTokens: p.spend.inputTokens,
        outputTokens: p.spend.outputTokens,
        cachedInputTokens: p.spend.cachedInputTokens,
        error: p.error,
        continuesExchangeId: p.continuesExchangeId ?? null,
      })
      .returning({ id: assistantExchange.id });
    await completeAssistantConversationStrategyTx(tx,ctx,p.strategy,row!.id);
    await addUsageTx(tx, ctx, p);
    await completeAssistantQuestionBudgetTx(tx,ctx,p.reservation,id);
  });
}

/** Accounting with NO raw content: the row is born retired (question '', no answer, receipt, tool inputs
 *  or error text — the shape the retirement CHECK pins), so nothing erased can come back through it.
 *  Returns false when the id already exists, i.e. the content transaction committed. */
async function persistAccountingOnly(ctx: SessionContext, id: string, p: PersistInput): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(assistantExchange)
      .values({
        tenantId: ctx.tenantId,
        appUserId: p.appUserId,
        id,
        question: '',
        answer: null,
        disclosureReceipt: null,
        toolCalls: [],
        contentRetiredAt: sql`clock_timestamp()`,
        turnCount: p.turnCount,
        hitTurnCap: p.hitTurnCap,
        stop: p.stop,
        provider: p.cfg.provider,
        model: p.cfg.model,
        inputTokens: p.spend.inputTokens,
        outputTokens: p.spend.outputTokens,
        cachedInputTokens: p.spend.cachedInputTokens,
        error: null,
      })
      .onConflictDoNothing({ target: assistantExchange.id })
      .returning({ id: assistantExchange.id });
    if (!row) return false;
    await addUsageTx(tx, ctx, p);
    await completeAssistantQuestionBudgetTx(tx,ctx,p.reservation,id);
    return true;
  });
}

/** Upsert the period counter. ON CONFLICT so two concurrent exchanges cannot lose one another's tokens —
 *  a ceiling that under-counts under load is a ceiling that does not hold. */
async function addUsageTx(tx: Tx, ctx: SessionContext, p: PersistInput): Promise<void> {
  await tx
    .insert(assistantUsage)
    .values({
      tenantId: ctx.tenantId,
      period: p.period,
      inputTokens: p.spend.inputTokens,
      outputTokens: p.spend.outputTokens,
      cachedInputTokens: p.spend.cachedInputTokens,
      exchangeCount: 1,
    })
    .onConflictDoUpdate({
      target: [assistantUsage.tenantId, assistantUsage.period],
      set: {
        inputTokens: sql`${assistantUsage.inputTokens} + ${p.spend.inputTokens}`,
        outputTokens: sql`${assistantUsage.outputTokens} + ${p.spend.outputTokens}`,
        cachedInputTokens: sql`${assistantUsage.cachedInputTokens} + ${p.spend.cachedInputTokens}`,
        exchangeCount: sql`${assistantUsage.exchangeCount} + 1`,
        updatedAt: sql`now()`,
      },
    });
}
