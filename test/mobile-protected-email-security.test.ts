/** Build and boot the actual protected bundle with an inherited test listener; no live DB/SMTP/installation. */
import {createServer} from 'node:net';
import {request} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,cp,rm,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {buildEmailSecurity} from '../deploy/security/build-email-security';
it('builds the real patched bundle and boots it under the supported private runtime without delivery authority',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aihr-private-mail-'));let child:ReturnType<typeof spawn>|undefined;
 try{
  const manifest=await buildEmailSecurity(join(directory,'artifact'));expect(manifest.agent.nodemailer).toBe('10.1.4');expect(manifest.runtime.node).toBe('22.23.3');expect(manifest.privateConfigurationRead).toBe(false);expect(manifest.inputHashes.length).toBeGreaterThan(10);
  execFileSync('python3',['-I','-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',join(directory,'artifact','maintenance.py')],{stdio:'pipe',timeout:15000});
  execFileSync(process.execPath,['--check',join(directory,'artifact','agent.cjs')],{stdio:'pipe',timeout:15000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));const port=(listener.address() as import('node:net').AddressInfo).port;
  const descriptor=(listener as unknown as {_handle:{fd:number}})._handle.fd;
  child=spawn(process.execPath,['-e','process.env.LISTEN_PID=String(process.pid);require(process.argv[1]);',join(directory,'artifact','agent.cjs')],{stdio:['ignore','pipe','pipe',descriptor],env:{PATH:process.env.PATH,NODE_ENV:'production',LISTEN_FDS:'1',IDENTITY_EMAIL_DATABASE_URL:'postgres://fixture:fixture@127.0.0.1:1/fixture',IDENTITY_EMAIL_CLIENT_SECRET:'fictional-not-sent',IDENTITY_EMAIL_REVISION_KEY:'fictional-not-an-installation-key',IDENTITY_EMAIL_TEST_RECIPIENT:'fixture@example.invalid',WORKFLOW_EMAIL_ORIGIN:'https://staging.example.invalid'}});
  await new Promise<void>((done,fail)=>listener.close(e=>e?fail(e):done()));
  let stderr='';child.stderr!.on('data',b=>{if(stderr.length<65536)stderr+=b;});child.stdout!.resume();
  const send=(path:string,body?:string)=>new Promise<{status:number;text:string}>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',timeout:2000},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode!,text}));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Fixture request timeout')));req.end(body);});
  let response:{status:number;text:string}|undefined;
  for(let i=0;i<40;i++){try{response=await send('/not-a-delivery-route');break;}catch{if(child.exitCode!==null)throw Error('Patched bundle exited before IPC: '+stderr);await new Promise(done=>setTimeout(done,100));}}
  expect(response?.status).toBe(404);
  const capabilities=await send('/v1/notifications','{"op":"status"}');expect(capabilities.status).toBe(200);expect(JSON.parse(capabilities.text)).toEqual({version:1,ready:false,assessmentReminders:true,assessmentReminderWords:true,attendanceCc:true,letters:false});expect((await send('/v1/notifications','{"op":"unsupported"}')).status).toBe(400);expect((await send('/v1/settings')).status).toBe(404);
  // Status refuses relay readiness with the absent lookup configuration and retains the Letters hold.
  // No dispatch, actor or credential request is submitted; no database/SMTP query is needed.
  expect(child.exitCode).toBeNull();
  if(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.AIHR_CI_HEAD===manifest.source){
   const selected=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]') as string[];
   if(selected.includes('test/mobile-protected-email-security.test.ts')){const output=join(realpathSync(process.env.RUNNER_TEMP!),'aihr-focused','protected-email-security');await mkdir(dirname(output),{recursive:true,mode:0o700});await cp(join(directory,'artifact'),output,{recursive:true,errorOnExist:true,force:false});}
  }
  expect(JSON.parse(await readFile(join(directory,'artifact','manifest.json'),'utf8')).agent.sha256).toBe(manifest.agent.sha256);
 }finally{
  if(child&&child.exitCode===null){const closed=new Promise<void>(done=>child!.once('close',()=>done()));child.kill('SIGTERM');const timer=setTimeout(()=>child!.kill('SIGKILL'),3000);await closed;clearTimeout(timer);}
  await rm(directory,{recursive:true,force:true});
 }
},60000);
