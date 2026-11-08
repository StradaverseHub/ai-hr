/** Native oid JSON can be decimal text. Canonical identity only; the original
 * full catalogue value remains untouched in every lifecycle guard. No coercion. */
export function employeeChoiceNativeObjectOid(value:unknown):string{
 if(typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value)&&BigInt(value)<=BigInt('4294967295'))return value;
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=4294967295)return String(value);
 throw Error('Canonical positive native uint32 object identity required');
}
