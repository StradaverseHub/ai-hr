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
