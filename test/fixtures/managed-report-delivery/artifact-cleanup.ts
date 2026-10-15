/** Test-import-safe fixture client. Only the renderer owns unlink; this client verifies its outcome. */
import {lstat} from 'node:fs/promises';
import {masterRendererRequest} from '../../../deploy/identity-email/render-context';
type Pair={id:string;token:string};
type RemoveRequest={phase:'remove';occurrenceId:string;leaseToken:string};
type Inspect=(path:string)=>Promise<unknown>;
export function ownedReportArtifactPath(pair:Pair):string {
 const request=masterRendererRequest.parse({phase:'remove',occurrenceId:pair.id,leaseToken:pair.token});
 if(request.phase!=='remove')throw new Error('Unexpected renderer request.');
 return '/var/lib/aihr-report-renderer/render/'+request.occurrenceId+'-'+request.leaseToken+'.xlsx';
}
export async function assertOwnedReportArtifactAbsent(pair:Pair,inspect:Inspect=lstat):Promise<void> {
 const path=ownedReportArtifactPath(pair);
 try{await inspect(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Owned artifact absence could not be verified.');}
 throw new Error('Owned report artifact is still present.');
}
export async function confirmOwnedReportArtifactRemoval(pair:Pair,send:(request:RemoveRequest)=>Promise<unknown>,inspect:Inspect=lstat):Promise<void> {
 ownedReportArtifactPath(pair); // Validate identity before any request or filesystem operation.
 const reply=await send({phase:'remove',occurrenceId:pair.id,leaseToken:pair.token});
 if(!reply||typeof reply!=='object'||Array.isArray(reply)||!('ok' in reply)||reply.ok!==true||!('removed' in reply)||reply.removed!==true)throw new Error('Renderer did not acknowledge artifact removal.');
 await assertOwnedReportArtifactAbsent(pair,inspect);
}
