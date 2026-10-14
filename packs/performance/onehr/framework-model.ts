import {z} from 'zod';
import {policySchema,type Policy,type Statement} from './model';

export const frameworkEditSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('add_principle'),name:z.string().trim().min(1).max(200),description:z.string().trim().max(2000)}),
 z.object({action:z.literal('edit_principle'),principleId:z.string().min(1).max(100),name:z.string().trim().min(1).max(200),description:z.string().trim().max(2000)}),
 z.object({action:z.literal('remove_principle'),principleId:z.string().min(1).max(100)}),
 z.object({action:z.literal('add_behaviour'),principleId:z.string().min(1).max(100),tier:z.number().int().min(0).max(29),future:z.boolean(),text:z.string().trim().min(1).max(2000)}),
 z.object({action:z.literal('edit_behaviour'),statementId:z.string().min(1).max(100),text:z.string().trim().min(1).max(2000)}),
 z.object({action:z.literal('remove_behaviour'),statementId:z.string().min(1).max(100)}),
]);
export type FrameworkEdit=z.infer<typeof frameworkEditSchema>;
export function leadershipPrinciples(policy:Pick<Policy,'framework'|'leadershipPrinciples'>):NonNullable<Policy['leadershipPrinciples']>{
 return policy.leadershipPrinciples??[...new Map(policy.framework.flatMap(tier=>tier.statements).map(statement=>[statement.principle,statement])).values()].map(statement=>({id:`principle:${statement.id}`,name:statement.principle,description:statement.principleDescription??'',aliases:[]}));
}
/** Stable statement identities survive renames. Removed questions stop scoring but their answers stay stored. */
export function editLeadershipFramework(policy:Policy,edit:FrameworkEdit,newId:()=>string):Policy{
 const next=structuredClone(policy),principles=leadershipPrinciples(next);next.leadershipPrinciples=principles;
 for(const tier of next.framework)for(const statement of tier.statements)statement.principleId??=principles.find(p=>p.name===statement.principle)!.id;
 const principle='principleId' in edit?principles.find(p=>!p.archived&&p.id===edit.principleId):undefined;
 if('principleId' in edit&&!principle)throw Error('This leadership principle changed. Reload before saving.');
 if('name' in edit&&principles.some(p=>p.id!==principle?.id&&[p.name,...p.aliases].includes(edit.name)))throw Error('Choose a distinct leadership principle name.');
 if(edit.action==='add_principle')principles.push({id:newId(),name:edit.name,description:edit.description,aliases:[]});
 if(edit.action==='edit_principle'){
  if(principle!.name!==edit.name)principle!.aliases=[...new Set([...principle!.aliases,principle!.name])];
  principle!.name=edit.name;principle!.description=edit.description;
 }
 if(edit.action==='remove_principle'){
  principle!.archived=true;
  for(const tier of next.framework)tier.statements=tier.statements.filter(s=>s.principleId!==edit.principleId);
 }
 if(edit.action==='add_behaviour'){
  const tier=next.framework[edit.tier];if(!tier)throw Error('Choose an existing leadership tier.');
  tier.statements.push({id:newId(),principleId:principle!.id,principle:principle!.name,text:edit.text,future:edit.future});
 }
 if(edit.action==='edit_behaviour'||edit.action==='remove_behaviour'){
  const tier=next.framework.find(t=>t.statements.some(s=>s.id===edit.statementId));if(!tier)throw Error('This behaviour changed. Reload before saving.');
  if(edit.action==='edit_behaviour')tier.statements.find(s=>s.id===edit.statementId)!.text=edit.text;
  else tier.statements=tier.statements.filter(s=>s.id!==edit.statementId);
 }
 for(const tier of next.framework)for(const statement of tier.statements){
  const p=next.leadershipPrinciples.find(p=>p.id===statement.principleId)!;statement.principle=p.name;statement.principleDescription=p.description;statement.principleAliases=p.aliases;
 }
 return policySchema.parse(next);
}
/** Keep prior principle wording in storage; display its comment under the renamed principle. */
export function currentPrincipleComments(statements:Statement[],comments:Record<string,string>){
 const result:Record<string,string>={};
 for(const statement of statements){const key=[statement.principle,...(statement.principleAliases??[]).slice().reverse()].find(key=>Object.hasOwn(comments,key));if(key)result[statement.principle]=comments[key];}
 return result;
}
