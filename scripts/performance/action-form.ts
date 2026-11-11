/** React's streaming action decoder must receive referenced form fields before the root model.
 * Integer-like object keys enumerate first, so Object.entries alone silently breaks the wire order. */
export function actionFormData(fields:Readonly<Record<string,unknown>>,originalOrder:readonly string[]=[]){
 const form=new FormData(),seen=new Set<string>();
 for(const key of [...originalOrder,...Object.keys(fields)]){
  if(key==='0'||seen.has(key)||!Object.hasOwn(fields,key))continue;
  seen.add(key);form.append(key,String(fields[key]));
 }
 if(Object.hasOwn(fields,'0'))form.append('0',String(fields['0']));
 return form;
}
