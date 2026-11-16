/** Run once after migration as schema owner. No Auth key rotation or credential/data changes. */
import postgres from 'postgres';
import {internalConfig} from '../lib/internal-auth/config';
import {resignationRuntimeKey} from '../lib/resignation-runtime-proof';
async function main(){
 if(!process.env.MIGRATION_DATABASE_URL)throw Error('Owner database URL required.');
 const owner=postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
 try {
  const key=resignationRuntimeKey(internalConfig().key);
  await owner.begin(async tx=>{
   await tx.unsafe("lock table app.resignation_runtime_verifier in exclusive mode");
   const [row]=await tx.unsafe('select secret=$1::bytea matches from app.resignation_runtime_verifier where singleton',[key]);
   if(row&&!row.matches)throw Error('Existing verifier differs; rotation requires a separate reviewed procedure.');
   if(!row)await tx.unsafe('insert into app.resignation_runtime_verifier(singleton,secret) values(true,$1::bytea)',[key]);
  });
  console.log('Resignation runtime verifier provisioned.');
 }finally{await owner.end({timeout:5});}
}
main().catch(()=>{console.error('Resignation runtime verifier provisioning refused. Check protected configuration and owner access.');process.exitCode=1;});
