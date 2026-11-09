import {expect,it} from 'vitest';
import {browserFailureLocation} from '../scripts/performance/browser-failure';
it('locates driver assertions without copying sensitive messages, stack paths or arbitrary error codes',()=>{
 const secret='fixture-password-and-session-value';
 const result=browserFailureLocation({code:'ERR_ASSERTION',message:secret,stack:'Error: '+secret+'\n at visit (file:///private/'+secret+'/system-load.mjs:241:17)'});
 expect(result).toEqual({errorCode:'ERR_ASSERTION',sourceLine:241,sourceColumn:17});
 expect(JSON.stringify(result)).not.toContain(secret);
 expect(browserFailureLocation({code:secret,stack:'Error: '+secret+'\n at signIn (file:///private/other.mjs:10:2)'})).toEqual({errorCode:null,sourceLine:null,sourceColumn:null});
 expect(browserFailureLocation(null)).toEqual({errorCode:null,sourceLine:null,sourceColumn:null});
});

it('binds the first owner frame to its exact public filename while preserving private stack redaction',()=>{
 const secret='fictional-session-and-password';
 const result=browserFailureLocation({code:'ERR_ASSERTION',message:secret,stack:'Error: '+secret+'\n at visit (file:///private/'+secret+'/system-load-owner.mjs:496:17)\n at run (file:///private/'+secret+'/system-load.mjs:2:1)'});
 expect(result).toEqual({errorCode:'ERR_ASSERTION',sourceLine:496,sourceColumn:17,sourceFile:'system-load-owner.mjs'});
 expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain('file:');expect(JSON.stringify(result)).not.toContain('/private');
});
it('keeps closed filenames, bounded numbers and unknown error codes out of owner diagnostics',()=>{
 const secret='fictional-private-message';
 for(const frame of ['not-system-load-owner.mjs:12:3','system-load-owner.mjs.backup:12:3','system-load-owner.mjs:1000000:3','system-load-owner.mjs:12:1000000','other.mjs:12:3']){
  expect(browserFailureLocation({code:secret,stack:'Error: '+secret+'\n at visit (file:///private/'+frame+')'})).toEqual({errorCode:null,sourceLine:null,sourceColumn:null});
 }
 expect(browserFailureLocation({code:secret,stack:'Error: '+secret+'\n at visit (file:///private/system-load-owner.mjs:999999:999999)\n at later (file:///private/system-load-owner.mjs:3:4)'})).toEqual({errorCode:null,sourceLine:999999,sourceColumn:999999,sourceFile:'system-load-owner.mjs'});
});
