/** Explicit runtime owner exception adapter. It never writes a normal/full PASS receipt. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {operatorRelease} from './operator-release.mjs';
import {verifyRuntimeRepairCi} from './verify-runtime-repair.mjs';
import {createRuntimeInstallGrant} from './runtime-install-grant.mjs';
export async function operatorRuntimeRepair({candidatePath,plan,execute=false}){
 let verified;
 const evidenceProtocol={kind:'runtime-owner-exception/v1',verify:async options=>{verified=await verifyRuntimeRepairCi({...options,plan});return verified.evidence;},
  revalidate:async evidence=>{if(evidence!==verified?.evidence)throw Error('Runtime acceptance identity changed');return verified.revalidate();},
  createGrant:({evidence,baselineBuildId,environmentSha256})=>{if(evidence!==verified?.evidence)throw Error('Runtime acceptance identity changed');return createRuntimeInstallGrant({acceptance:evidence.acceptance,evidence,snapshot:verified.snapshot,baselineBuildId,environmentSha256});}};
 return operatorRelease({candidatePath,execute,evidenceProtocol});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,candidatePath,planFile]=process.argv.slice(2);if(process.argv.length!==5||!['verify','deploy'].includes(mode))throw Error('Usage: operator-runtime-repair.mjs <verify|deploy> <clean-candidate> <private-plan.json>');
 operatorRuntimeRepair({candidatePath,plan:JSON.parse(readFileSync(planFile)),execute:mode==='deploy'}).then(r=>console.log(JSON.stringify({kind:r.kind,result:r.result,sha:r.sha,runId:r.runId,evidenceDirectory:r.evidenceDirectory,arrivalVerified:r.arrivalVerified??false,ownedResourceCleanupVerified:r.ownedResourceCleanupVerified??false,releaseHandbackVerified:r.releaseHandbackVerified??false,fullGatePassCreated:false}))).catch(e=>{console.error(e);process.exitCode=1;});
}
