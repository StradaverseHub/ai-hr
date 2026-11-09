import {expect,it} from 'vitest';
import {browserFailureLocation,browserPreflightClickObstruction,browserPreflightErrorFingerprint,browserPreflightFailureLocation} from '../scripts/performance/browser-failure';
it('locates driver assertions without copying sensitive messages, stack paths or arbitrary error codes',()=>{
 const secret='fixture-password-and-session-value';
 const result=browserFailureLocation({code:'ERR_ASSERTION',message:secret,stack:'Error: '+secret+'\n at visit (file:///private/'+secret+'/system-load.mjs:241:17)'});
 expect(result).toEqual({errorCode:'ERR_ASSERTION',sourceLine:241,sourceColumn:17});
 expect(JSON.stringify(result)).not.toContain(secret);
 expect(browserFailureLocation({code:secret,stack:'Error: '+secret+'\n at signIn (file:///private/other.mjs:10:2)'})).toEqual({errorCode:null,sourceLine:null,sourceColumn:null});
 expect(browserFailureLocation(null)).toEqual({errorCode:null,sourceLine:null,sourceColumn:null});
});

it('projects only reviewed preflight frames and fixed browser fingerprints',()=>{
 const secret='fixture-session-token';
 const location=browserPreflightFailureLocation({stack:'Error: '+secret+'\n at capture (file:///private/'+secret+'/navigation-browser-capture.ts:310:11)\n at run (file:///private/'+secret+'/system-load-owner.mjs:1040:8)'});
 expect(location).toEqual({sourceFile:'navigation-browser-capture.ts',sourceLine:310,sourceColumn:11});
 expect(JSON.stringify(location)).not.toContain(secret);
 expect(browserPreflightFailureLocation({stack:'Error: /navigation-browser-capture.ts:310:11\n at unsafe (/tmp/not-navigation-browser-capture.ts:2:3)'}))
  .toEqual({sourceFile:null,sourceLine:null,sourceColumn:null});
 for(const code of [418,422,423,425]){
  expect(browserPreflightErrorFingerprint('Minified React error #'+code+'; visit /?args='+secret)).toBe('react-minified-'+code);
 }
 expect(browserPreflightErrorFingerprint('Minified React error #4188; '+secret)).toBe('other');
 expect(browserPreflightErrorFingerprint('An error occurred in the Server Components render. '+secret)).toBe('next-server-component-render');
 expect(browserPreflightErrorFingerprint(secret)).toBe('other');
});

it('attributes the first baseline workflow assertion to a reviewed frame without revealing its contents',()=>{
 const secret='fictional-session-and-person-detail';
 for(const file of ['org-explorer-browser.mjs','personnel-switcher-browser.mjs','payroll-browser.mjs','fixture-workload.mjs']){
  const stack='AssertionError: '+secret+'\n at helper (file:///private/'+secret+'/'+file+':84:7)\n at run (file:///private/system-load-owner.mjs:1172:5)';
  const location=browserPreflightFailureLocation({stack});
  expect(location).toEqual({sourceFile:file,sourceLine:84,sourceColumn:7});
  expect(JSON.stringify(location)).not.toContain(secret);
 }
 expect(browserPreflightFailureLocation({stack:'Error: '+secret+'\n at source (/tmp/payroll-browser.mjs.copy:22:4)'}))
  .toEqual({sourceFile:null,sourceLine:null,sourceColumn:null});
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

it('projects only closed click timeout reasons without exposing locator or obstruction details',()=>{
 const secret='fixture-session-and-dom-value';
 const timeout=(detail:string)=>({name:'TimeoutError',message:'locator.click: Timeout 125.5ms exceeded.\nCall log:\n  - waiting for '+secret+'\n  - '+detail});
 expect(browserPreflightClickObstruction(timeout('<div>'+secret+'</div> intercepts pointer events'))).toBe('pointer-intercepted');
 expect(browserPreflightClickObstruction(timeout('element is outside of the viewport'))).toBe('outside-viewport');
 expect(browserPreflightClickObstruction(timeout('element is not stable'))).toBe('element-unstable');
 expect(browserPreflightClickObstruction(timeout('element is not visible'))).toBe('element-invisible');
 expect(browserPreflightClickObstruction(timeout('element is not enabled'))).toBe('element-disabled');
 expect(browserPreflightClickObstruction(timeout('element was detached from the DOM, retrying'))).toBe('element-detached');
 expect(browserPreflightClickObstruction(timeout(secret))).toBe('click-timeout');
 expect(browserPreflightClickObstruction({name:'TimeoutError',message:'locator.waitFor: Timeout 125ms exceeded. '+secret})).toBeNull();
 expect(browserPreflightClickObstruction({...timeout(secret),name:'Error'})).toBeNull();
 expect(browserPreflightClickObstruction(null)).toBeNull();
});
