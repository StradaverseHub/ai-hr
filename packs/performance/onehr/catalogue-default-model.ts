import { policySchema, type Policy } from './model';
export const catalogueFields=['profiles','skills','careerRoutes'] as const;
export type Catalogue=Pick<Policy,'profiles'|'skills'|'careerRoutes'|'framework'|'leadershipPrinciples'>;
export function catalogueOf(policy:Policy):Catalogue {
 return {profiles:policy.profiles.map(({employmentIds: _assignments,...profile})=>profile),skills:policy.skills??[],careerRoutes:policy.careerRoutes??[],framework:policy.framework,...(policy.leadershipPrinciples?{leadershipPrinciples:policy.leadershipPrinciples}:{})};
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Apply only this edit's changed identities; unrelated edits in another cycle must survive. */
export function mergeCatalogueChanges(previous:Catalogue,next:Catalogue,current:Catalogue):Catalogue {
 const result={...current};
 for(const field of catalogueFields){
  const key=(row:any)=>field==='careerRoutes'?JSON.stringify([row.fromProfileId,row.toProfileId]):row.id;
  const before=new Map((previous[field]??[]).map(row=>[key(row),row])),after=new Map((next[field]??[]).map(row=>[key(row),row]));
  const target=new Map((current[field]??[]).map(row=>[key(row),row]));
  for(const id of new Set([...before.keys(),...after.keys()])){
   if(same(before.get(id),after.get(id)))continue;
   if(!same(target.get(id),before.get(id))&&!same(target.get(id),after.get(id)))throw Error('This catalogue entry was changed in another cycle. Open that catalogue before changing the same entry.');
   if(after.has(id))target.set(id,after.get(id)!);else target.delete(id);
  }
  Object.assign(result,{[field]:[...target.values()]});
 }
 const oldFramework={framework:previous.framework,leadershipPrinciples:previous.leadershipPrinciples},newFramework={framework:next.framework,leadershipPrinciples:next.leadershipPrinciples};
 if(!same(oldFramework,newFramework)){
  if(!same({framework:current.framework,leadershipPrinciples:current.leadershipPrinciples},oldFramework)&&!same({framework:current.framework,leadershipPrinciples:current.leadershipPrinciples},newFramework))throw Error('The leadership framework was changed in another cycle. Open that framework before changing it.');
  result.framework=next.framework;result.leadershipPrinciples=next.leadershipPrinciples;
 }
 return result;
}
export function policyWithCatalogue(policy:Policy,catalogue:Partial<Catalogue>|null){return policySchema.parse({...policy,...(catalogue??{})});}
