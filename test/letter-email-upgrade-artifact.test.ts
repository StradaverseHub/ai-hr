/** Build the actual private service installer on CI; never execute it or contact an installation. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('builds a source-bound Letters-capable private workflow installer without installing it',()=>{
 const directory='deploy/identity-email/generated',output=join(directory,'workflow-upgrade.cjs'),hadDirectory=existsSync(directory);
 expect(existsSync(output)).toBe(false);
 try{
  const log=execFileSync(process.execPath,['--import','tsx','scripts/build-workflow-email-upgrade.ts'],{encoding:'utf8',timeout:25000});
  const bytes=readFileSync(output),text=bytes.toString('utf8'),digest=createHash('sha256').update(bytes).digest('hex');
  expect(bytes.length).toBeGreaterThan(10000);expect(log).toContain('Root upgrade sha256: '+digest);
  expect(log).toMatch(/Service bundle sha256: [a-f0-9]{64}/);
  expect(text).toContain('letterWorkflowUpgradeReady');expect(text).toContain('Root required');
  // Syntax validation parses the artifact only. Calling the installer would mutate a root-owned host.
  execFileSync(process.execPath,['--check',output],{stdio:'pipe',timeout:10000});
  const selected=process.env.AIHR_FOCUSED_TESTS;
  if(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&selected&&JSON.parse(selected).includes('test/letter-email-upgrade-artifact.test.ts')){
   const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();expect(head).toBe(process.env.AIHR_CI_HEAD);
   const parent=realpathSync(process.env.RUNNER_TEMP!),target=join(parent,'aihr-focused','private-workflow-email-upgrade');mkdirSync(target,{recursive:true,mode:0o700});
   writeFileSync(join(target,'workflow-upgrade.cjs'),bytes,{flag:'wx',mode:0o600});
   const sources=execFileSync('git',['ls-files','--','deploy/identity-email','lib/notification-email-model.ts','scripts/build-workflow-email-upgrade.ts','pnpm-lock.yaml'],{encoding:'utf8'}).trim().split('\n');
   const manifest={kind:'PRIVATE_WORKFLOW_EMAIL_INSTALLER_NOT_APPLIED',schemaVersion:1,source:head,controller:process.env.AIHR_CI_CONTROL_HEAD,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,sha256:digest,bytes:bytes.length,agentSha256:log.match(/Service bundle sha256: ([a-f0-9]{64})/)![1],runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},sourceHashes:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),syntaxChecked:true,installerExecuted:false,hostWrites:false,mailSent:false,releaseAuthorized:false};
   writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  }
 }finally{
  if(existsSync(output))unlinkSync(output);
  if(!hadDirectory&&existsSync(directory))rmdirSync(directory);
 }
},40000);
