import {matches,specificity,type Facts,type Routing,type Group} from './onboarding-model';
/** The On/Off Boarding registry keeps its own match vocabulary and specificity. Never relabel Shared rules as native. */
export type NativeDocumentRoutingFacts=Pick<Facts,'businessGroup'|'company'|'department'|'title'|'grade'|'employmentType'>&Partial<Pick<Facts,'joinDate'|'finalConfirmationDate'|'confirmationDate'|'probationEndDate'|'provisionalEndOn'>>;
export function resolveNativeDocumentRouting(routing:Routing,facts:NativeDocumentRoutingFacts,groups:readonly Group[],available:(userId:string)=>boolean):{userIds:string[];groupId:string|null;reason:string|null}{
 const rows=routing.rows.map((row,index)=>({row,index})).filter(({row})=>matches(row.rules,facts as Facts)).sort((a,b)=>specificity(b.row.rules)-specificity(a.row.rules)||a.index-b.index);
 const matched=rows[0]?.row;
 if(!matched)return{userIds:[],groupId:null,reason:`No row of “${routing.name}” matches this employee.`};
 const group=groups.find(group=>group.id===matched.group);
 if(group?.members.some(available))return{userIds:[...group.members],groupId:group.id,reason:null};
 // This is the native owner's existing empty-rule fallback, not a Shared routing conversion.
 const fallback=routing.rows.find(row=>specificity(row.rules)===0),fallbackGroup=groups.find(group=>group.id===fallback?.group);
 if(fallbackGroup?.members.some(available))return{userIds:[...fallbackGroup.members],groupId:fallbackGroup.id,reason:null};
 return{userIds:group?[...group.members]:[],groupId:matched.group,reason:group?'Nobody in the matching On/Off Boarding group is available.':'The matching On/Off Boarding group no longer exists.'};
}
