/** Bounded diagnostics: never publish error messages, full stacks, URLs or credentials. */
export function browserFailureLocation(error:unknown){
 const value=error as {code?:unknown;stack?:unknown}|null;
 const frame=typeof value?.stack==='string'?value.stack.match(/system-load\.mjs:(\d{1,6}):(\d{1,6})(?:\)|\s|$)/):null;
 return {errorCode:value?.code==='ERR_ASSERTION'?'ERR_ASSERTION':null,
  sourceLine:frame?Number(frame[1]):null,sourceColumn:frame?Number(frame[2]):null};
}
