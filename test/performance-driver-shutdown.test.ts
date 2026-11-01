/** Regression for a successful isolated preflight hanging on the native verifier's extra pool. */
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
async function child(omitNative:boolean){
 const moduleUrl=(file:string)=>JSON.stringify(pathToFileURL(resolve(file)).href);
 const code=`import postgres from 'postgres';
 import {client} from ${moduleUrl('db/client.ts')};
 import {closePerformanceDbPools} from ${moduleUrl('scripts/performance/driver-shutdown.mjs')};
 const observer=postgres(process.env.DATABASE_URL,{max:1});
 const [native]=await client\`select current_user as role\`;
 const [driver]=await observer\`select current_user as role\`;
 const closed=[];
 await closePerformanceDbPools(${omitNative?'undefined':'client'},observer,key=>closed.push(key));
 process.stdout.write(JSON.stringify({nativeRole:native.role,driverRole:driver.role,closed})+'\\n');`;
 return new Promise<{exitCode:number|null;leaked:boolean;result:{nativeRole:string;driverRole:string;closed:string[]}}>((resolveChild,reject)=>{
  const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',leaked=false,readyTimer:ReturnType<typeof setTimeout>|undefined;
  const startup=setTimeout(()=>{proc.kill('SIGKILL');reject(Error('Native shutdown child did not reach its completed database reads'));},20000);
  proc.stdout.on('data',chunk=>{
   stdout+=chunk.toString();if(!stdout.includes('\n')||readyTimer)return;clearTimeout(startup);
   // Only measure exit after actual DB reads and cleanup completed; transpiler startup is excluded.
   readyTimer=setTimeout(()=>{leaked=true;proc.kill('SIGTERM');},2500);
  });
  proc.stderr.on('data',chunk=>{stderr+=chunk.toString();});proc.once('error',reject);
  proc.once('exit',exitCode=>{
   clearTimeout(startup);clearTimeout(readyTimer);
   try{const result=JSON.parse(stdout.trim());resolveChild({exitCode,leaked,result});}
   catch{reject(Error('Native shutdown child failed before its completion marker: '+stderr.slice(-500)));}
  });
 });
}
it('detects the original observer-only cleanup leaving the native pool alive',async()=>{
 const result=await child(true);expect(result.leaked).toBe(true);expect(result.exitCode).toBeNull();
 expect(result.result).toMatchObject({nativeRole:'ai_hr_app',driverRole:'ai_hr_app'});
},30000);
it('exits normally after closing both actual restricted-role pools',async()=>{
 const result=await child(false);expect(result.leaked).toBe(false);expect(result.exitCode).toBe(0);
 expect(result.result).toEqual({nativeRole:'ai_hr_app',driverRole:'ai_hr_app',closed:['nativeAuditPoolClosed','driverPoolClosed']});
},30000);
