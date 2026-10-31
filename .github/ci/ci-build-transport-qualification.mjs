/** Actual fresh-VM byte qualification entry point; never release/DB authority. */
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCiTransportInvocation} from './ci-build-transport-policy.mjs';
import {consumeBuild,authenticateCiTransportOrigin} from './build-transport.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--metadata-only'){
  assertCiTransportInvocation(process.env);
  authenticateCiTransportOrigin(process.env);
  console.log(JSON.stringify({kind:'CI_TRANSPORT_METADATA_ONLY_NOT_BYTE_PROOF',releaseAuthorized:false}));
 }else if(args.length===0){
  consumeBuild({qualification:'ci',output:join(process.env.RUNNER_TEMP,'ci-build-transport-qualification')})
   .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
 }else throw Error('Usage: ci-build-transport-qualification.mjs [--metadata-only]');
}
