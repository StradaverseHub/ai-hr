import {withTenant,type SessionContext} from '@/db/client';
import {readProfilePresentationSnapshotPolicyTx} from '@/core/profile-edit-policy';
import {myOwnEmploymentSubjectsTx} from '@/core/read';
import {readOwnProfileWorkspaceSnapshotTx} from '@/core/profile-edit';
import {readOwnProfileFactsSnapshotTx} from '@/core/profile-view';
import {myProfileChangeRequestsSnapshotTx} from '@/core/profile';
import {settleReadGroup} from '@/lib/settle-read-group';

/** The own subject, visibility policy and displayed profile facts agree at snapshot admission.
 * Separate writes and the photo download recheck their own current authority. */
export function readMyProfilePresentation(supplied:SessionContext,requestedEmploymentId?:string){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 return withTenant(ctx,async tx=>{
  const presentation=await readProfilePresentationSnapshotPolicyTx(tx,ctx);
  const current=presentation.ctx;
  const own=await myOwnEmploymentSubjectsTx(tx,current,{profileEdit:true});
  const selected=requestedEmploymentId?own.find(row=>row.employmentId===requestedEmploymentId):own.length===1?own[0]:null;
  if(!selected)return {kind:own.length?'choose':'unlinked',presentation,own} as const;

  const {employmentId}=selected;
  const projection=await readOwnProfileFactsSnapshotTx(tx,employmentId,presentation);
  if(!projection)return {kind:'unlinked',presentation,own} as const;
  const [workspace,profileRequests]=await settleReadGroup([
   ()=>readOwnProfileWorkspaceSnapshotTx(tx,{employmentId},presentation),
   ()=>myProfileChangeRequestsSnapshotTx(tx,current,presentation),
  ]);
  return {kind:'ready',presentation,own,...projection,workspace,profileRequests} as const;
 },{readOnlySnapshot:true});
}
