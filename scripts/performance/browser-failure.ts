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
