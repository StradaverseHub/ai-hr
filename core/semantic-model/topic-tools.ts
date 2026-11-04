/** Spec v23 (AI v2 Phase 2 hardening, coordinator decision of 4 November 2026) — topic tools: one provider tool that
 * serves a family of declared reads, each as one topic, so every role's biggest turn stays within the provider's tool
 * ceiling (lib/ai/teras-harness-policy.ts, 32 per call) with two tools of headroom. Phase 2 put an HR administrator's
 * biggest turn at 39.
 *
 * A topic is exactly the read it names (./generate.ts TERAS_READS): the same native runner and permission gate
 * (core/explainers/capabilities.ts TERAS_CAPABILITIES: administrator, payroll or team access, module, worker switch), the
 * same semantic entity and disclosure, the same inputs, the same kit entry (core/improvement/kit-registry.ts), corpus
 * turn and page. Only the binding changes: the harness binds the topic tool, never the read, and a caller who is not
 * permitted a topic is refused it (not_permitted) before its runner. This file declares which read each topic is and
 * generates the topic tool's provider-facing spec from those reads; pure, no session, read or effect.
 *
 * The topic names and their order are mirrored by the conversation spec's offer.topicTools, which a test
 * pins, so a change here is a spec change. */
import type {AiJsonSchema,AiToolSpec} from '../../lib/ai/types';
import {describeRead,readInputSchema,TERAS_READS,terasEntity} from './generate';
import type {SemanticRead} from './types';

const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export type TopicToolDeclaration=Readonly<{name:string;purpose:string;topics:readonly Readonly<{topic:string;read:string}>[]}>;
export const TOPIC_TOOLS:readonly TopicToolDeclaration[]=freeze([
 // The administrators' operations reads: AI v2 W8's loops overview and the five Phase 2 administrator reads.
 {name:'operations_status',
  purpose:'Administrators only: how AI Centre\'s operations stand for the companies they administer, one topic per call, each as its own page shows it. Pick the topic the question is about; call again with another topic for another. Topics:',
  topics:[{topic:'loops',read:'loops_overview'},{topic:'payroll_cycle',read:'payroll_cycle_status'},{topic:'salary_payroll',read:'salary_payroll_checks'},
   {topic:'payroll_loop_settings',read:'payroll_loop_settings'},{topic:'payroll_audit',read:'payroll_audit_status'},{topic:'ai_quality',read:'ai_quality_summary'},
   // Payroll history learning (P2): its own gate (payroll administrators) and entity; no new tool. Needs spec v24's topic list.
   {topic:'payroll_learning',read:'payroll_learning_status'}]},
 // The "Why?" explainers: ADR-0170 step 4's three and AI v2 W5's two, all under the explainers worker switch.
 {name:'explain_why',
  purpose:'Why one of the asking person\'s own figures is what it is, from its native owner\'s own working, one topic per call. Pick the topic the question is about; quote its figures exactly and name only the causes it lists. Topics:',
  topics:[{topic:'pay_difference',read:'explain_pay_difference'},{topic:'payslip_statutory',read:'explain_payslip_statutory'},{topic:'claim_limit',read:'explain_claim_limit'},
   {topic:'leave_entitlement',read:'explain_leave_entitlement'},{topic:'attendance_day',read:'explain_attendance_day'}]},
] satisfies TopicToolDeclaration[]);

/** Every read a topic tool serves, by read name: its tool and topic. */
export const FOLDED_READS:ReadonlyMap<string,Readonly<{tool:string;topic:string}>>=new Map(TOPIC_TOOLS.flatMap(tool=>tool.topics.map(row=>[row.read,Object.freeze({tool:tool.name,topic:row.topic})] as const)));
const readOf=(name:string):SemanticRead=>{const read=TERAS_READS.find(row=>row.name===name);if(!read)throw Error('A topic names an undeclared read: '+name);return read;};
/** The declared read behind one topic of one topic tool, or null. */
export function topicRead(tool:string,topic:unknown):SemanticRead|null{
 const row=TOPIC_TOOLS.find(item=>item.name===tool)?.topics.find(item=>item.topic===topic);
 return row?readOf(row.read):null;
}

type Schema=Record<string,unknown>;
const sameSchema=(a:Schema,b:Schema)=>{const {description:_a,...left}=a,{description:_b,...right}=b;return JSON.stringify(left)===JSON.stringify(right);};
/** One property for an input several topics take. The same schema stays as it is; different schemas become a plain
 * string, and each topic's own schema is checked again for that topic before its runner, by the harness tool provider. */
function mergedInput(rows:readonly Readonly<{topic:string;schema:Schema;required:boolean}>[]):Schema{
 const say=(row:{topic:string;schema:Schema;required:boolean})=>`${row.topic}${row.required?' (required)':''}: ${String(row.schema.description??'')}`.trim();
 const first=rows[0].schema;
 if(rows.every(row=>sameSchema(row.schema,first)))return{...first,description:rows.map(say).join(' ')};
 return{type:'string',description:rows.map(say).join(' ')};
}
/** The topic tool's input schema: a required topic from the closed list, and every input any topic takes, each optional
 * here (a topic's own required inputs are checked for that topic). */
export function topicToolInputSchema(tool:TopicToolDeclaration):AiJsonSchema{
 const inputs=new Map<string,{topic:string;schema:Schema;required:boolean}[]>();
 for(const row of tool.topics){const read=readOf(row.read),schema=readInputSchema(read) as unknown as {properties:Record<string,Schema>;required:string[]};
  for(const [name,property] of Object.entries(schema.properties)){if(name==='topic')throw Error('A topic read may not take an input named topic.');
   inputs.set(name,[...(inputs.get(name)??[]),{topic:row.topic,schema:property,required:schema.required.includes(name)}]);}}
 return{type:'object',properties:{topic:{type:'string',enum:tool.topics.map(row=>row.topic),description:'Which topic to read.'},
  ...Object.fromEntries([...inputs].map(([name,rows])=>[name,mergedInput(rows)]))},required:['topic'],additionalProperties:false} as AiJsonSchema;
}
let specs:readonly AiToolSpec[]|undefined;
/** The provider-facing spec of every topic tool: its purpose, then each topic's own generated description (the read's
 * purpose, its disclosable fields by class and its scope, exactly as the read's own tool spec says them). */
export function topicToolSpecs():readonly AiToolSpec[]{
 specs??=freeze(TOPIC_TOOLS.map(tool=>({name:tool.name,
  description:[tool.purpose,...tool.topics.map(row=>{const read=readOf(row.read);return `[${row.topic}] ${describeRead(read,terasEntity(read.entity))}`;})].join(' '),
  inputSchema:topicToolInputSchema(tool)})));
 return specs;
}
export const topicToolSpec=(name:string):AiToolSpec|undefined=>topicToolSpecs().find(spec=>spec.name===name);
