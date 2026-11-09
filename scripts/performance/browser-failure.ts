/** Bounded diagnostics: never publish error messages, full stacks, URLs or credentials. */
export function browserFailureLocation(error:unknown){
 const value=error as {code?:unknown;stack?:unknown}|null;
 const frame=typeof value?.stack==='string'?value.stack.match(/(?:^|[/\\( \t])(system-load(?:-owner)?\.mjs):(\d{1,6}):(\d{1,6})(?:\)|\s|$)/):null;
 return {errorCode:value?.code==='ERR_ASSERTION'?'ERR_ASSERTION':null,
  sourceLine:frame?Number(frame[2]):null,sourceColumn:frame?Number(frame[3]):null,
  ...(frame?.[1]==='system-load-owner.mjs'?{sourceFile:'system-load-owner.mjs' as const}:{})};
}

/** Only approved harness stack frames leave the development failure report. */
export function browserPreflightFailureLocation(error:unknown){
 const value=error as {stack?:unknown}|null;
 const stack=typeof value?.stack==='string'?value.stack.slice(0,8192):'';
 const frame=stack.match(/^\s+at [^\r\n]*?[/\\](system-load-owner\.mjs|navigation-browser-capture\.ts|navigation-protocol\.ts|navigation-entry\.ts|navigation-shell-browser\.ts):(\d{1,4}):(\d{1,4})(?:\))?$/m);
 return {sourceFile:frame?.[1]??null,sourceLine:frame?Number(frame[2]):null,sourceColumn:frame?Number(frame[3]):null};
}

/** A closed signal for browser error families, without the message or its arguments. */
export function browserPreflightErrorFingerprint(message:string){
 const react=message.match(/^(?:Error: )?Minified React error #(418|422|423|425);/);
 if(react)return 'react-minified-'+react[1];
 if(message.startsWith('An error occurred in the Server Components render.'))return 'next-server-component-render';
 return 'other';
}


/** Classify a real Playwright click timeout without emitting its actionability log. */
export function browserPreflightClickObstruction(error:unknown){
 const value=error as {name?:unknown;message?:unknown}|null;
 if(value?.name!=='TimeoutError'||typeof value.message!=='string')return null;
 const message=value.message.slice(0,16384);
 if(!/^locator\.click: Timeout [0-9]+(?:\.[0-9]+)?ms exceeded\./.test(message))return null;
 const callLog=message.split('\nCall log:\n',2)[1]??'';
 if(callLog.includes('intercepts pointer events'))return 'pointer-intercepted';
 if(callLog.includes('element is outside of the viewport'))return 'outside-viewport';
 if(callLog.includes('element is not stable'))return 'element-unstable';
 if(callLog.includes('element is not visible'))return 'element-invisible';
 if(callLog.includes('element is not enabled'))return 'element-disabled';
 if(callLog.includes('element was detached from the DOM'))return 'element-detached';
 return 'click-timeout';
}
