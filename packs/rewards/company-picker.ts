export type RewardCompanyClassification={companyId:string;disposition:'visible'|'test_demo'|'alias';canonicalCompanyId:string|null;reason:string;updatedAt:string};
/** Follow scoped People Management company ancestry; never infer grouping from a display name. */
export function rewardCompanyBusinessGroup(companyId:string,tree:readonly{id:string;name:string;parentId:string|null}[]){
 const nodes=new Map(tree.map(node=>[node.id,node])),start=nodes.get(companyId);if(!start)return null;
 let current=start;const seen=new Set([current.id]);
 while(current.parentId){const parent=nodes.get(current.parentId);if(!parent||seen.has(parent.id))return null;seen.add(parent.id);current=parent;}
 return current.id!==start.id||tree.some(node=>node.parentId===start.id)?{groupId:current.id,groupName:current.name}:null;
}
