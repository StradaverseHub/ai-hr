/** Capture candidates only, not authorization or a read-only SQL validator.
 * Native RR/RO and the canonical query object remain the actual execution owner. */
export function employeeChoicePlanQuery(text:string){
 return /^\s*(?:select|with)\b/i.test(text);
}
