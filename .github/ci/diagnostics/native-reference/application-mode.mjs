/** Observe ONLY context present on the unchanged native Program's literal.
 * Missing native parents are a graph gap, never a default resolution mode. */
export function observeNativeUsageResolution(ts,program,file,literal,options){
 const parent=literal.parent;
 if(parent===undefined)return{mode:null,modeObserved:false,resolutionAttempted:false,nativeParentKind:null,resolvedModule:null};
 // TS5.9.3's public method requires usage.parent. Preserve its actual undefined
 // return separately from unavailable context, and pass that exact value on.
 const mode=program.getModeForUsageLocation(file,literal);
 const resolved=ts.resolveModuleName(literal.text,file.fileName,options,ts.sys,undefined,undefined,mode);
 return{mode:mode??null,modeObserved:true,resolutionAttempted:true,nativeParentKind:parent.kind,resolvedModule:resolved.resolvedModule??null};
}
