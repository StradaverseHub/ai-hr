/** Bounded diagnostics: never publish error messages, full stacks, URLs or credentials. */
export function browserFailureLocation(error:unknown){
 const value=error as {code?:unknown;stack?:unknown}|null;
 const frame=typeof value?.stack==='string'?value.stack.match(/(?:^|[/\\( \t])(system-load(?:-owner)?\.mjs):(\d{1,6}):(\d{1,6})(?:\)|\s|$)/):null;
 return {errorCode:value?.code==='ERR_ASSERTION'?'ERR_ASSERTION':null,
  sourceLine:frame?Number(frame[2]):null,sourceColumn:frame?Number(frame[3]):null,
  ...(frame?.[1]==='system-load-owner.mjs'?{sourceFile:'system-load-owner.mjs' as const}:{})};
}
