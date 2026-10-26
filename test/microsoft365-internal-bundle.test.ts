/** Builds the actual private installer; never installs units or opens database/SMTP connections. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {expect,it} from 'vitest';
it('ships the exact token peer and both private units inside the built Reports installer',()=>{
 const directory='deploy/identity-email/generated',output=directory+'/internal-report-upgrade.cjs',hadDirectory=existsSync(directory);
 // Never overwrite an operator's pre-existing generated artifact.
 expect(existsSync(output)).toBe(false);
 try{
  const log=execFileSync(process.execPath,['--import','tsx','deploy/identity-email/build-internal-reports.ts'],{cwd:process.cwd(),encoding:'utf8',timeout:25000});
  const bundle=readFileSync(output,'utf8');expect(bundle.length).toBeGreaterThan(10000);
  for(const name of ['smtp-token-peer.py','aihr-smtp-token.socket','aihr-smtp-token@.service']){
   const source=readFileSync('deploy/identity-email/'+name),hash=createHash('sha256').update(source).digest('hex');
   expect(log).toContain(name+' SHA256: '+hash);expect(bundle).toContain(source.toString('base64'));
  }
 }finally{
  if(existsSync(output))unlinkSync(output);
  if(!hadDirectory&&existsSync(directory))rmdirSync(directory);
 }
},30000);
