/** ADR-0170 §3.12 step 3, step 5c — each top signal cluster becomes a DRAFT improvement item.
 *
 * A draft is the payload the existing improve loop takes (scripts/improve/README.md): the fields of an
 * operator-raised feedback item (category, title, description, expected behaviour) and a plan in the
 * consultant-readable plain-text format of the feedback-plan skill (VERDICT/SIZE line, THE SITUATION TODAY,
 * WHAT WE'LL CHANGE, WHAT YOU'LL GET, GOOD TO KNOW, then a dashed line and BUILD NOTES).
 *
 * Drafts are data for a local file only (scripts/teras/draft-improvements.ts writes them). There is no tenant,
 * reporter or board id in a draft and nothing here can push, raise, reply or change a status: an operator
 * reads the file, and a person decides whether any of it reaches a board through the existing commands.
 * Built from the triage report alone, so a draft carries only counts, categories, tool and role names.
 * Every plan states that no guard, permission, disclosure rule or delegable job changes without a person. */
import type {Classification,SignalCluster,SignalReport} from './signals';

export type DraftCategory='issue'|'enhancement'|'new_function';
export type ImprovementDraft=Readonly<{kind:'teras.improvement-draft';version:1;
 /** Stable per cluster, so a later run can tell a recurring draft from a new one. */
 draftKey:string;status:'draft_local_only';
 raise:Readonly<{category:DraftCategory;title:string;description:string;expectedBehavior:string}>;
 plan:string;model:'teras.improvement-engine/v1';
 evidence:Readonly<Pick<SignalCluster,'signal'|'category'|'classification'|'count'|'people'|'roles'|'rank'>>}>;

const CATEGORY_OF:Readonly<Record<Classification,DraftCategory>>={missing_capability:'new_function',missing_context:'enhancement',interface_gap:'enhancement',harness_defect:'issue',guard_gap:'issue'};
/** Plain words for a category; module and tool names otherwise read with spaces. */
const WORDS:Readonly<Record<string,string>>={product_context:'how-to and where-is questions',none:'questions no tool covers yet',actions:'requests to change something',
 company:'company-wide records',reply_check:'replies that failed a safety check twice',other:'uncategorised cases',tool_not_permitted:'records the person may not see',
 other_person:'questions about another person',instruction_override:'messages asking the Assistant to ignore its rules',attachment:'messages with a file attached',
 workplace_harm:'requests to judge a colleague',budget_steps:'conversations that ran out of steps',budget_tokens:'conversations that ran out of length',
 budget_time:'conversations that ran out of time',budget_spend:'conversations that ran out of budget'};
const words=(category:string)=>WORDS[category]??(category.startsWith('sensitive_')?'sensitive '+category.slice(10).replace(/_/g,' ')+' messages':category.startsWith('check_')?'the '+category.slice(6).replace(/_/g,' ')+' check':category.replace(/[_.]/g,' '));
const times=(count:number)=>count===1?'once':count+' times';
const people=(count:number)=>count===1?'1 person':count+' people';
const roles=(names:readonly string[])=>names.length?names.map(name=>name.replace(/_/g,' ')).join(', '):'not recorded';
const size=(cluster:SignalCluster)=>cluster.classification==='missing_capability'?'Large':cluster.classification==='guard_gap'||cluster.count<5?'Quick':'Moderate';

type Text=Readonly<{title:string;situation:string;change:readonly string[];result:string;know:readonly string[];build:readonly string[];expected:string}>;
function text(cluster:SignalCluster):Text{
 const what=words(cluster.category),seen=`${times(cluster.count)}, for ${people(cluster.people)}`;
 const none='No rule about who may see or do what is changed by this item. A person approves every change before it is built.';
 switch(cluster.signal){
  case 'no_tool_or_action':return{title:`The Assistant could not help with ${what} (${seen})`,
   situation:`People asked the Assistant about ${what} and it had to say it cannot help yet. This happened ${seen}. They had to find the answer in the product themselves.`,
   change:['Give the Assistant a way to look this up for the person asking, showing only what that person can already see in the product.','Add test questions so the answer is checked on every release.'],
   result:'People get the answer in the conversation instead of a dead end, with a link to the page where they can check it.',know:[none],
   build:[`Signal: no_tool_or_action, category ${cluster.category}.`,'Use the capability kit (core/improvement/kit.ts): declare the native owner, its permission and its semantic entity; the kit generates the tool spec, card binding, review link and draft corpus turns, and the standard contract tests run on it.','Draft corpus turns need a person to review the ideals before they join the probe.'],
   expected:`The Assistant answers ${what} from the product's own records, for the person asking.`};
  case 'no_guide_found':return{title:`No guide answered ${what} (${seen})`,
   situation:`People asked the Assistant how to do something and no guide in the product covered it. This happened ${seen}.`,
   change:['Write a short guide section for the missing topic, in plain steps.','Link it from the page it describes.'],
   result:'The Assistant can point to a written answer, and people who read the guides directly find it too.',know:['HR can mark the new section as checked once it matches how the company works.',none],
   build:[`Signal: no_guide_found (inferred: honest gap after a product_guidance lookup and no private read).`,'Add the section to content/guides and its manifest; keep translations in step (docs/KNOWLEDGE-BASE-MAINTENANCE.md).','Add a corpus turn whose ideal is guide mode.'],
   expected:'A guide section answers the question.'};
  case 'needs_review_fallback':return{title:`The Assistant fell back to a safe reply for ${what} (${seen})`,
   situation:`The Assistant could not finish a reliable answer and showed its safe fallback message instead. This happened ${seen}.`,
   change:['Find why these answers fail the checks and fix the cause.','Add each failing case as a permanent test.'],
   result:'Fewer conversations end with "please try again".',know:[none],
   build:[`Signal: needs_review_fallback, reason ${cluster.category}.`,'Reproduce with a scripted model in test/harness-ratchet; any instruction change is a new harness spec version and goes through the model comparison report (scripts/teras/compare-models.ts).'],
   expected:'The turn completes without the fallback reply.'};
  case 'reply_check_retry':return{title:`Replies needed a second try: ${what} (${seen})`,
   situation:`The Assistant's first reply broke a rule and had to be written again. This happened ${seen}. People waited longer for an answer.`,
   change:['Adjust the Assistant\'s guidance so the first reply already follows the rule.','Keep the check itself exactly as strict as it is.'],
   result:'Faster answers, with the same protection.',know:[none],
   build:[`Signal: reply_check_retry, check ${cluster.category}.`,'The reply check is not loosened; only instructions change, as a new spec version through the comparison report.'],
   expected:'The first reply passes the check.'};
  case 'tool_call_failure':return{title:`The Assistant misused a lookup: ${what} (${seen})`,
   situation:`The Assistant asked for a lookup in a way the product refused. This happened ${seen}. The answer took longer or was incomplete.`,
   change:['Make the lookup\'s description clearer so it is asked for correctly.','Add the failing pattern as a permanent test.'],
   result:'More complete answers on the first attempt.',know:[none],
   build:[`Signal: tool_call_failure, tool ${cluster.category}.`,'The tool description is generated from the semantic model (core/semantic-model/generate.ts); fix the declaration, not the generated text.'],
   expected:'The lookup is asked for correctly.'};
  case 'guard_block':return{title:`Review a protection that stopped ${what} (${seen})`,
   situation:`The Assistant's protections stopped ${what}. This happened ${seen}. That may be exactly right, or people may need a better way to get help.`,
   change:['A person reviews whether this protection is right for these cases.','If people need help the Assistant cannot give, show them where to go instead.'],
   result:'Protections stay in place, and people who are stopped know their next step.',know:['The improvement engine never changes a protection. Any change to it needs its own reviewed decision.'],
   build:[`Signal: guard_block, reason ${cluster.category}.`,'No guard, gate pattern or disclosure class may change from this item without a recorded review (ADR-0170 §3.12 Guards row); the ratchet tests enforce it.'],
   expected:'A person has reviewed the protection; people who are stopped get a clear next step.'};
  case 'suggestion_rejected':return{title:`People turned down suggestions for ${what} (${seen})`,
   situation:`The Assistant suggested ${what}, and people declined it on the review page. This happened ${seen}.`,
   change:['Look at what the review page shows for this change and make it match what people need to decide.'],
   result:'Suggestions people actually want, and a review page that is easier to decide on.',know:[none],
   build:[`Signal: suggestion_rejected, job ${cluster.category}.`,'Cards render from proposal objects (core/proposals/card.ts); change the declaration or the proposal facts, not a per-action renderer.'],
   expected:'Fewer suggestions are declined.'};
  case 'suggestion_reversed':return{title:`People undid accepted suggestions for ${what} (${seen})`,
   situation:`People accepted a suggestion for ${what} and later undid it. This happened ${seen}. That means the suggestion looked right but was not.`,
   change:['Find what the Assistant missed before suggesting this, and add that check.','Add each undone case as a permanent test.'],
   result:'Suggestions that hold up after people accept them.',know:[none],
   build:[`Signal: suggestion_reversed, job ${cluster.category}.`,'Read the outcome records\' rule versions and native check results for these runs; add a ratchet case.'],
   expected:'Accepted suggestions are not undone.'};
 }
}

/** Plain text in the feedback-plan skeleton. */
function planText(cluster:SignalCluster,body:Text):string{
 const bullets=(rows:readonly string[])=>rows.map(row=>'- '+row).join('\n\n');
 return['VERDICT: Not built yet   ·   SIZE: '+size(cluster),'THE SITUATION TODAY',body.situation,'WHAT WE\'LL CHANGE',bullets(body.change),'WHAT YOU\'LL GET',body.result,
  'GOOD TO KNOW',bullets(body.know),'------------------------------------------------------------','BUILD NOTES (technical - skip this if you are reviewing the request)',
  bullets([...body.build,`Evidence: ${cluster.count} signals, ${cluster.people} people, roles ${roles(cluster.roles)}, rank ${cluster.rank}, classified ${cluster.classification}. Counts and categories only; no question text leaves the tenant (ADR-0170 §3.12).`])].join('\n\n');
}

/** Drafts for the `top` highest-ranked clusters. Pure. */
export function draftImprovements(report:SignalReport,options:Readonly<{top?:number}>={}):readonly ImprovementDraft[]{
 return Object.freeze(report.clusters.slice(0,Math.max(0,options.top??5)).map(cluster=>{
  const body=text(cluster);
  return Object.freeze({kind:'teras.improvement-draft' as const,version:1 as const,draftKey:'teras:'+cluster.key,status:'draft_local_only' as const,
   raise:Object.freeze({category:CATEGORY_OF[cluster.classification],title:body.title,description:body.situation,expectedBehavior:body.expected}),
   plan:planText(cluster,body),model:'teras.improvement-engine/v1' as const,
   evidence:Object.freeze({signal:cluster.signal,category:cluster.category,classification:cluster.classification,count:cluster.count,people:cluster.people,roles:cluster.roles,rank:cluster.rank})});
 }));
}
