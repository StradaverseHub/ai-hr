import { z } from 'zod';
import { careerSchema, goalSchema, type Career, type DevelopmentGoal } from './model';
const span=z.object({start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const goalFields={area:span.optional(),dueOn:span.optional(),onJob:span.optional(),fromOthers:span.optional(),formalLearning:span.optional()};
export const careerCommandsSchema=z.object({commands:z.array(z.discriminatedUnion('action',[
 z.object({action:z.literal('career_field'),field:z.enum(['aspiration','aspirationNow','aspirationLong','strengths','preferences','mentor','mobilityNote']),value:span}).strict(),
 z.object({action:z.literal('mobility'),value:span}).strict(),
 z.object({action:z.literal('role_choice'),field:z.enum(['selfProfileId','targetProfileId']),id:z.uuid(),target:span}).strict(),
 z.object({action:z.literal('add_goal'),...goalFields,area:span}).strict(),
 z.object({action:z.literal('edit_goal'),id:z.uuid(),target:span,...goalFields}).strict(),
 z.object({action:z.literal('remove_goal'),id:z.uuid(),target:span}).strict(),
])).max(30)}).strict();
export type CareerCommandFacts={text:string;career:Career;careerRevision:number|null;planRevision:number|null;goals:DevelopmentGoal[];canEditGoals:boolean;roles:{id:string;label:string}[]};
const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en');
/** Employee words and explicit catalogue choices only. Sharing and career sign-off have no command. */
export function adjudicateCareerCommands(raw:string,facts:CareerCommandFacts){
 try{
  const proposal=careerCommandsSchema.parse(JSON.parse(raw)),career=structuredClone(facts.career),goals=structuredClone(facts.goals),used=new Set<string>();
  const extract=(s:z.infer<typeof span>)=>{if(s.end>facts.text.length||s.start>=s.end)throw Error('Invalid message span.');return facts.text.slice(s.start,s.end).trim();};
  for(const c of proposal.commands){
   const key=c.action==='career_field'||c.action==='role_choice'?c.field:c.action==='mobility'?'mobility':c.action==='add_goal'?`new:${extract(c.area)}`:c.id;
   if(used.has(key))throw Error('Conflicting updates.');used.add(key);
   if(c.action==='career_field'){career[c.field]=extract(c.value);continue;}
   if(c.action==='mobility'){career.mobility=careerSchema.shape.mobility.parse(normal(extract(c.value)));continue;}
   if(c.action==='role_choice'){
    const label=extract(c.target),target=facts.roles.find(r=>r.id===c.id);
    if(!target||normal(target.label)!==normal(label)||facts.roles.filter(r=>normal(r.label)===normal(label)).length!==1)throw Error('Choose one current catalogue role exactly.');
    career[c.field]=c.id;continue;
   }
   if(!facts.canEditGoals)throw Error('This plan is not editable.');
   if(c.action==='add_goal'){
    const patch=Object.fromEntries(Object.entries(c).filter(([k])=>k in goalFields).map(([k,v])=>[k,extract(v as z.infer<typeof span>)]));
    goals.push(goalSchema.parse({id:crypto.randomUUID(),area:'',dueOn:'',onJob:'',fromOthers:'',formalLearning:'',status:'not_started',managerComment:'',...patch}));continue;
   }
   const goal=goals.find(g=>g.id===c.id),label=extract(c.target);
   if(!goal||normal(goal.area)!==normal(label)||goals.filter(g=>normal(g.area)===normal(label)).length!==1)throw Error('Name one existing goal exactly.');
   if(c.action==='remove_goal')goals.splice(goals.indexOf(goal),1);
   else for(const [k,v] of Object.entries(c))if(k in goalFields)Object.assign(goal,{[k]:extract(v as z.infer<typeof span>)});
  }
  const checkedCareer=careerSchema.parse(career),checkedGoals=goalSchema.array().max(100).parse(goals);
  return {ok:true as const,proposal,career:checkedCareer,goals:checkedGoals,careerChanged:JSON.stringify(checkedCareer)!==JSON.stringify(facts.career),goalsChanged:JSON.stringify(checkedGoals)!==JSON.stringify(facts.goals)};
 }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:'Invalid career command.'};}
}
