/** Privileged service installation, after realm configuration and application migration 0527. */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, chmod, chown, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { emailServiceDatabaseGrants, workflowEmailDatabaseGrants } from './database';
import { customerEmailDatabase, customerSocketGroup } from './customer-install';
async function main(){
 if(process.getuid?.()!==0)throw new Error('Root required');
 const envPath='/etc/aihr-keycloak/email-agent.env';let env=await readFile(envPath,'utf8');
 if(env.includes('IDENTITY_EMAIL_DATABASE_URL='))throw new Error('Already installed; inspect before retrying');
 const migrationURL=process.env.MIGRATION_DATABASE_URL;if(!migrationURL)throw new Error('Migration database required');
 const prepared=process.env.AIHR_IDENTITY_EMAIL_DATABASE_URL;
 const url=prepared?customerEmailDatabase(migrationURL,prepared):new URL(migrationURL),password=randomBytes(32).toString('hex');
 if(!prepared&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Remote HR database requires a precreated service role');
 const appUser=process.env.AIHR_APP_USER??'ubuntu';
 customerSocketGroup(appUser);
 const socketGroup=customerSocketGroup(execFileSync('id',['-gn',appUser],{encoding:'utf8'}).trim());
 const db=postgres(migrationURL,{max:1});
 try{
  await db.begin(async tx=>{
   // The migration role intentionally cannot create cluster roles. Root uses local postgres only here.
   if(!prepared) execFileSync('runuser',['-u','postgres','--','psql','-v','ON_ERROR_STOP=1','-q'],{input:`CREATE ROLE aihr_identity_email LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,stdio:['pipe','ignore','pipe']});
   if(prepared){
    const [role]=await tx`select rolname from pg_roles r where rolname='aihr_identity_email'
      and rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolreplication
      and not exists(select 1 from pg_auth_members m where m.member=r.oid)
      and not exists(select 1 from pg_database d where d.datdba=r.oid)
      and not exists(select 1 from pg_namespace n where n.nspowner=r.oid)
      and not exists(select 1 from pg_class c where c.relowner=r.oid)
      and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app','identity_email') and c.relkind in ('r','p','v','m','f')
        and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))`;
    if(!role)throw new Error('Prepared identity role is missing or privileged');
   }
   for(const grant of [...emailServiceDatabaseGrants(decodeURIComponent(url.pathname.slice(1))),...workflowEmailDatabaseGrants()]) await tx.unsafe(grant);
  });
 }finally{await db.end();}
 if(!prepared){url.username='aihr_identity_email';url.password=password;}
 // Prove the supplied remote credential actually logs in as the restricted service account.
 const probe=postgres(url.toString(),{max:1});
 try{const [who]=await probe`select current_user as name`;if(who?.name!=='aihr_identity_email')throw new Error('Incorrect service account');}finally{await probe.end();}
 env+='IDENTITY_EMAIL_DATABASE_URL='+url.toString()+'\n';await writeFile(envPath,env,{mode:0o600});
 const dest='/usr/local/lib/aihr-identity-email';await mkdir(dest,{recursive:true,mode:0o755});
 for(const path of ['/usr','/usr/local','/usr/local/lib',dest]){
  const stat=await lstat(path);if(!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022)!==0)throw new Error('Untrusted runtime directory');
 }
 await chmod(dest,0o755);
 // /opt/node20 belongs to the web OS account on this installation. Never execute it in this service.
 await copyFile(process.execPath,dest+'/node',constants.COPYFILE_EXCL);
 await chmod(dest+'/node',0o755);await chown(dest+'/node',0,0);
 await build({entryPoints:['deploy/identity-email/agent.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',outfile:dest+'/agent.cjs',logLevel:'silent'});
 await chmod(dest+'/agent.cjs',0o644);await chown(dest+'/agent.cjs',0,0);
 for(const file of ['aihr-identity-email.socket','aihr-identity-email.service']){
  const unit=(await readFile('deploy/identity-email/'+file,'utf8')).replace('SocketGroup=ubuntu','SocketGroup='+socketGroup);
  await writeFile('/etc/systemd/system/'+file,unit,{mode:0o644});await chmod('/etc/systemd/system/'+file,0o644);
 }
 execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['enable','--now','aihr-identity-email.socket']);
 console.log('Private email settings socket installed; no email has been sent.');
}
main().catch(()=>{console.error('Identity email installation failed. Inspect private setup files before retrying.');process.exitCode=1;});
