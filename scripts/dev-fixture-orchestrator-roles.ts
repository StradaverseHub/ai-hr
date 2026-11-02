/** Explicit hosted fictional bootstrap; ordinary db:migrate never invokes this entry point. */
import {prepareOrchestratorDraftDiscardRoles} from '../test/helpers/personnel-draft-discard-ci-role-fixture';
async function main(){
 if(process.argv.length!==3)throw Error('One fixed runner-owned evidence directory required.');
 const result=await prepareOrchestratorDraftDiscardRoles('postgres://postgres@127.0.0.1:5433/postgres',process.argv[2]);
 process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{console.error('Hosted fictional role prerequisites refused; no migration bypass.');process.exitCode=1;});
