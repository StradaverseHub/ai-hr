/** Run once after migration as schema owner. No Auth key rotation or credential/data changes. */
import postgres from 'postgres';
import {internalConfig} from '../lib/internal-auth/config';
import {organisationAdmissionKey} from '../lib/internal-auth/organisation-admission-proof';
async function main(){
 if(!process.env.MIGRATION_DATABASE_URL)throw Error('Owner database URL required.');
 const owner=postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
 try {
  const key=organisationAdmissionKey(internalConfig().key);
  await owner.begin(async tx=>{
   await tx.unsafe("lock table app.organisation_admission_verifier in exclusive mode");
   const [row]=await tx.unsafe('select secret=$1::bytea matches from app.organisation_admission_verifier where singleton',[key]);
   if(row&&!row.matches)throw Error('Existing verifier differs; rotation requires a separate reviewed procedure.');
   if(!row)await tx.unsafe('insert into app.organisation_admission_verifier(singleton,secret) values(true,$1::bytea)',[key]);
  });
  console.log('Organisation admission verifier provisioned.');
 }finally{await owner.end({timeout:5});}
}
main().catch(()=>{console.error('Organisation admission verifier provisioning refused. Check protected configuration and owner access.');process.exitCode=1;});
