/** Binary codec controls only. No native profile, capture, install or admission. */
import {expect,it} from 'vitest';
import {notificationRecipeSealBytes,notificationRecipeSealFormat,type NotificationRecipeSealRow} from '../lib/notification-worker/recipe-seal';
import {notificationWorkerProjectionContract,notificationWorkerAssessmentContract} from '../lib/notification-worker/projection';
const row:NotificationRecipeSealRow={eventType:'é',kind:'k',category:null,recipientPort:null,implemented:true,audience:'subject',guard:null};
it('matches an independent literal UTF8/length/null/boolean/header vector exactly',()=>{
 const actual=notificationRecipeSealBytes([row],2);
 expect(actual.bytes.toString('hex')).toBe('414948525f4e4f54494649434154494f4e5f5245434950455f5345414c00000000010000000200000001525400000002c3a954000000016b4e4e5954000000077375626a6563744e');
 expect(actual).toMatchObject({formatVersion:1,apiVersion:2,recipeCount:1,byteLength:72,sha256:'b26d5009d5527dfd780532f47f1809935e6f8660167ea3755882f7467204ed4a'});
});
it('sorts complete identities by exact UTF8 bytes without mutating, trimming, folding or erasing Unicode distinctions',()=>{
 const rows=[{...row,eventType:'😀'},{...row,eventType:'é'},{...row,eventType:'z'},{...row,eventType:'a'}];
 const before=JSON.stringify(rows);expect(notificationRecipeSealBytes(rows,2).bytes.equals(notificationRecipeSealBytes([...rows].reverse(),2).bytes)).toBe(true);expect(JSON.stringify(rows)).toBe(before);
 const base=notificationRecipeSealBytes([row],2).sha256;
 for(const eventType of ['e\u0301','É',' é','é ','e|k'])expect(notificationRecipeSealBytes([{...row,eventType}],2).sha256).not.toBe(base);
 expect(()=>notificationRecipeSealBytes([row,{...row,category:'review'}],2)).toThrow('Duplicate');
});
it('binds every complete metadata field, API version and null/object/absent-not/present-true guard shape',()=>{
 const base=notificationRecipeSealBytes([row],2).sha256;
 const changed:NotificationRecipeSealRow[]=[{...row,eventType:'other'},{...row,kind:'other'},{...row,category:'review'},{...row,audience:'none'},{...row,audience:'reader',recipientPort:'contract'},{...row,implemented:false},
  {...row,guard:{field:'notify',equals:true}},{...row,guard:{field:'notify',equals:true,not:true}},{...row,guard:{field:'overtime',equals:true}}];
 expect(new Set(changed.map(value=>notificationRecipeSealBytes([value],2).sha256)).size).toBe(changed.length);
 for(const value of changed)expect(notificationRecipeSealBytes([value],2).sha256).not.toBe(base);
 expect(notificationRecipeSealBytes([row],3).sha256).not.toBe(base);
 const reader={...row,audience:'reader',recipientPort:'contract'};
 expect(notificationRecipeSealBytes([reader],2).sha256).not.toBe(notificationRecipeSealBytes([{...reader,recipientPort:'payrollClosed'}],2).sha256);
});
it('refuses missing/unknown/defaulted or non-JSON metadata and preserves absent versus null/undefined not',()=>{
 for(const guard of [{field:'notify',equals:true,not:null},{field:'notify',equals:true,not:undefined},{field:'notify',equals:true,not:false},{field:'notify',equals:true,unknown:1},{field:'notify'},{field:'other',equals:true},{}])expect(()=>notificationRecipeSealBytes([{...row,guard}],2)).toThrow();
 for(const value of [{},{...row,unknown:'ignored?'},{...row,audience:undefined},{...row,guard:undefined},{...row,category:undefined},{...row,audience:'reader'},{...row,recipientPort:'contract'},{...row,eventType:'a\0b'},{...row,eventType:'\ud800'}])expect(()=>notificationRecipeSealBytes([value],2)).toThrow();
 const inherited=Object.create(row);expect(()=>notificationRecipeSealBytes([inherited],2)).toThrow();
 const hidden={...row};Object.defineProperty(hidden,'kind',{value:'k',enumerable:false});expect(()=>notificationRecipeSealBytes([hidden],2)).toThrow();
 let getterCalls=0;const accessor={...row};Object.defineProperty(accessor,'kind',{get:()=>{getterCalls++;throw Error('Getter must not execute');},enumerable:true});expect(()=>notificationRecipeSealBytes([accessor],2)).toThrow();expect(getterCalls).toBe(0);
 const arrayAccessor=[row];Object.defineProperty(arrayAccessor,'0',{get:()=>{getterCalls++;throw Error('Array getter must not execute');},enumerable:true});expect(()=>notificationRecipeSealBytes(arrayAccessor,2)).toThrow();expect(getterCalls).toBe(0);
 const extraArray=[row];Object.defineProperty(extraArray,'unbound',{value:true,enumerable:true});expect(()=>notificationRecipeSealBytes(extraArray,2)).toThrow();
 const oversizedArray=Array.from({length:notificationRecipeSealFormat.maximumRows+1},()=>row);Object.defineProperty(oversizedArray,'0',{get:()=>{getterCalls++;throw Error('Oversized array must refuse before traversal');},enumerable:true});expect(()=>notificationRecipeSealBytes(oversizedArray,2)).toThrow('row bound');expect(getterCalls).toBe(0);
 for(const version of [0,1,4,null,'2'])expect(()=>Reflect.apply(notificationRecipeSealBytes,undefined,[[row],version])).toThrow();
});
it('binds both complete qualified source contracts while refusing operational overflows without clipping',()=>{
 const projection=notificationRecipeSealBytes(notificationWorkerProjectionContract,2),assessment=notificationRecipeSealBytes(notificationWorkerAssessmentContract,3);
 expect(projection.recipeCount).toBe(66);expect(assessment.recipeCount).toBe(66);expect(projection.sha256).not.toBe(assessment.sha256);
 expect(projection.byteLength).toBe(projection.bytes.length);expect(assessment.byteLength).toBe(assessment.bytes.length);expect(assessment.byteLength).toBeLessThan(notificationRecipeSealFormat.maximumBytes);
 expect(()=>notificationRecipeSealBytes([],2)).toThrow();
 expect(()=>notificationRecipeSealBytes([{...row,eventType:'x'.repeat(notificationRecipeSealFormat.maximumBytes)}],2)).toThrow('byte bound');
 expect(()=>notificationRecipeSealBytes(Array.from({length:notificationRecipeSealFormat.maximumRows+1},(_,index)=>({...row,eventType:String(index)})),2)).toThrow();
});
