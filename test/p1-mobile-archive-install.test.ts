/** Shipping-input acceptance. No server tree/root node_modules can rescue this installation. */
import {it,expect} from 'vitest';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';

it('the isolated portable archive typechecks and emits both production native bundles',()=>{
 const source=resolve('.'),archive=mkdtempSync(join(tmpdir(),'aihr-native-archive-'));
 try {
  execFileSync('git',['init','-q',archive]);writeFileSync(join(archive,'.gitignore'),readFileSync('.easignore'));
  const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const filtered=spawnSync('git',['-C',archive,'check-ignore','--no-index','-z','--stdin'],{input:paths.join('\0')+'\0',encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  expect(filtered.status).toBe(0);const omitted=new Set(filtered.stdout.split('\0').filter(Boolean));
  for(const path of paths.filter(p=>!omitted.has(p))){const target=join(archive,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(source,path),target);}
  expect(existsSync(join(archive,'lib/mobile-api/v2/team.ts'))).toBe(true);
  for(const path of ['package.json','node_modules','db','lib/session.ts','.env.local'])expect(existsSync(join(archive,path))).toBe(false);
  const cwd=join(archive,'mobile');
  const env={...process.env,EXPO_OFFLINE:'1',EXPO_NO_TELEMETRY:'1',NODE_OPTIONS:'--max-old-space-size=6144'};
  const run=(args:string[],timeout:number)=>{
   const result=spawnSync('npm',args,{cwd,env,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
   expect(result.error).toBeUndefined();expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
  };
  run(['ci','--no-audit','--no-fund'],300000);
  expect(existsSync(join(archive,'node_modules'))).toBe(false);
  run(['exec','--offline','--','tsc','--noEmit'],90000);
  run(['exec','--offline','--','expo','export','--platform','ios','--platform','android','--max-workers','2','--output-dir',join(archive,'bundles')],180000);
  expect(existsSync(join(archive,'bundles/metadata.json'))).toBe(true);
 } finally {rmSync(archive,{recursive:true,force:true});}
},600000);
