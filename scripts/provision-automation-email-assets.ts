/** Source-only operator procedure. Execute only for an explicitly approved target after its migration is installed. */
import postgres from 'postgres';
import {internalConfig} from '../lib/internal-auth/config';
import {automationEmailAssetKey} from '../lib/automation-email-asset-proof';
async function main(){
 if(!process.env.MIGRATION_DATABASE_URL)throw new Error('Owner database URL required.');
 const owner=postgres(process.env.MIGRATION_DATABASE_URL,{max:1});
 try{
  const key=automationEmailAssetKey(internalConfig().key);
  await owner.begin(async tx=>{
   await tx.unsafe('lock table app.automation_email_asset_verifier in exclusive mode');
   const [row]=await tx.unsafe('select secret=$1::bytea matches from app.automation_email_asset_verifier where singleton',[key]);
   if(row&&!row.matches)throw new Error('Existing verifier differs; rotation requires a separately reviewed procedure.');
   if(!row)await tx.unsafe('insert into app.automation_email_asset_verifier(singleton,secret) values(true,$1::bytea)',[key]);
  });
  console.log('Shared email asset verifier provisioned.');
 }finally{await owner.end({timeout:5});}
}
main().catch(()=>{console.error('Shared email asset verifier provisioning refused. Check protected configuration and owner access.');process.exitCode=1;});
