/** The independent calculation marker follows the HR decision. Remove only that
 * marker; malformed or other raw evidence must survive for the source owner to refuse. */
export function attendancePolicyAttestedRawTrace<T>(trace:T):T|null{
 if(trace!==null&&typeof trace==='object'&&!Array.isArray(trace)
  &&Object.keys(trace).length===1&&Object.prototype.hasOwnProperty.call(trace,'overtimePattern'))return null;
 return trace;
}
