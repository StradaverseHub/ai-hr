/** Pure redaction/shape controls only; no launch admission, runtime or DB proof. */
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {exactAsciiLaunchObservationShape} from './performance/employee-choice-exact-ascii-launch-observation';
import {exactAsciiLaunchShape} from './performance/employee-choice-exact-ascii-runtime-contract';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
it('observes separate versus equals flags and fixed value categories without returning preload paths',()=>{
 const args=['--experimental-import-meta-resolve','--require','/private/fictional/suppress-warnings.cjs','--conditions','node','--conditions=development','--max-old-space-size=4096'];
 const shape=exactAsciiLaunchObservationShape(args);expect(shape.status).toBe('bounded');if(shape.status!=='bounded')throw Error('Expected bounded model');
 expect(shape.count).toBe(7);expect(shape.tokens.map(row=>[row.index,row.name,row.form,row.category])).toEqual([
  [0,'--experimental-import-meta-resolve','bare','no-inline-value'],[1,'--require','bare','no-inline-value'],[2,null,'value','vitest-preload-basename-only'],
  [3,'--conditions','bare','no-inline-value'],[4,null,'value','node-condition'],[5,'--conditions','equals','development-condition'],[6,'--max-old-space-size','equals','heap4096']]);
 expect(shape.sha256).toBe(digest(JSON.stringify(args)));expect(JSON.stringify(shape)).not.toContain('/private/fictional');
});
it('redacts unknown flag names, raw values, data URLs and private path content',()=>{
 const secret='FICTIONAL_PRIVATE_VALUE_82',shape=exactAsciiLaunchObservationShape(['--'+secret+'='+secret,'--import=data:text/javascript,'+secret,'/private/'+secret,'--require=/private/'+secret]);
 const serialized=JSON.stringify(shape);expect(serialized).not.toContain(secret);expect(serialized).not.toContain('data:text');expect(serialized).not.toContain('/private/');
 expect(shape.status).toBe('bounded');if(shape.status!=='bounded')throw Error('Expected bounded redaction model');
 expect(shape.tokens[0]).toMatchObject({kind:'unknown-flag',name:null,category:'redacted'});expect(shape.tokens[1]).toMatchObject({name:'--import',category:'redacted'});
});
it('refuses malformed, sparse, NUL-bearing and oversized argument facts with static reasons',()=>{
 for(const input of [null,{},[1],['nul\0private'],Array(1),Array(65).fill('node'),['x'.repeat(4097)]]){
  const result:unknown=Reflect.apply(exactAsciiLaunchObservationShape,undefined,[input]);expect(result).toMatchObject({status:'refused'});expect(JSON.stringify(result)).not.toContain('private');
 }
 expect(exactAsciiLaunchObservationShape([])).toMatchObject({status:'bounded',count:0});
});
it('never evaluates accessor arguments or mutates the original launch array',()=>{
 let calls=0;const accessor:string[]=[];Object.defineProperty(accessor,'0',{get(){calls++;return 'private';}});
 expect(exactAsciiLaunchObservationShape(accessor)).toEqual({status:'refused',reason:'argument-type'});expect(calls).toBe(0);
 const input=Object.freeze(['--conditions=node','--max-old-space-size=6144']),before=JSON.stringify(input);const result=exactAsciiLaunchObservationShape(input);
 expect(JSON.stringify(input)).toBe(before);expect(Object.isFrozen(result)).toBe(true);if(result.status==='bounded'){expect(Object.isFrozen(result.tokens)).toBe(true);expect(result.tokens.every(Object.isFrozen)).toBe(true);}
});
it('caps encoded observations rather than exposing an unbounded argument transcript',()=>{
 const result=exactAsciiLaunchObservationShape(Array(64).fill('--experimental-import-meta-resolve'));
 expect(result).toEqual({status:'refused',reason:'observation-output-bound'});expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128);
});
it('diagnostic knowledge cannot admit the currently refused separate-token launch',()=>{
 const separate=['--experimental-import-meta-resolve','--require','/owned/suppress-warnings.cjs','--conditions','node'];
 expect(exactAsciiLaunchShape(separate)).toBeNull();expect(exactAsciiLaunchObservationShape(separate).status).toBe('bounded');expect(exactAsciiLaunchShape(separate)).toBeNull();
 expect(exactAsciiLaunchShape(['--experimental-import-meta-resolve','--require','/owned/suppress-warnings.cjs','--conditions=node'])).toEqual({preload:'/owned/suppress-warnings.cjs'});
});
