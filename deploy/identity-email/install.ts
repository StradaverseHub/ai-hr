/** Privileged service installation, after realm configuration and application migration 0525. */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, chmod, chown } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { emailServiceDatabaseGrants } from './database';
async function main(){
 if(process.getuid?.()!==0)throw new Error('Root required');
 const envPath='/etc/aihr-keycloak/email-agent.env';let env=await readFile(envPath,'utf8');
 if(env.includes('IDENTITY_EMAIL_DATABASE_URL='))throw new Error('Already installed; inspect before retrying');
 const migrationURL=process.env.MIGRATION_DATABASE_URL;if(!migrationURL)throw new Error('Migration database required');
 const url=new URL(migrationURL),password=randomBytes(32).toString('hex');
 const db=postgres(migrationURL,{max:1});
 try{
  await db.begin(async tx=>{
   // The migration role intentionally cannot create cluster roles. Root uses local postgres only here.
   execFileSync('runuser',['-u','postgres','--','psql','-v','ON_ERROR_STOP=1','-q'],{input:`CREATE ROLE aihr_identity_email LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,stdio:['pipe','ignore','pipe']});
   for(const grant of emailServiceDatabaseGrants(decodeURIComponent(url.pathname.slice(1)))) await tx.unsafe(grant);
  });
 }finally{await db.end();}
 url.username='aihr_identity_email';url.password=password;
 env+='IDENTITY_EMAIL_DATABASE_URL='+url.toString()+'\n';await writeFile(envPath,env,{mode:0o600});
 const dest='/usr/local/lib/aihr-identity-email';await mkdir(dest,{recursive:true,mode:0o755});
 await build({entryPoints:['deploy/identity-email/agent.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',outfile:dest+'/agent.cjs',logLevel:'silent'});
 await chmod(dest+'/agent.cjs',0o644);await chown(dest+'/agent.cjs',0,0);
 for(const file of ['aihr-identity-email.socket','aihr-identity-email.service']){
  await copyFile('deploy/identity-email/'+file,'/etc/systemd/system/'+file);await chmod('/etc/systemd/system/'+file,0o644);
 }
 execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['enable','--now','aihr-identity-email.socket']);
 console.log('Private email settings socket installed; no email has been sent.');
}
main().catch(()=>{console.error('Identity email installation failed. Inspect private setup files before retrying.');process.exitCode=1;});
