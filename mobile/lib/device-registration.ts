/** One bounded registration secret. Serialized deletion prevents late writes after logout/reinstall. */
import * as SecureStore from 'expo-secure-store';
const KEY='aihr.clockDevice';
const STORE={keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
let epoch=0;
let writes:Promise<unknown>=Promise.resolve();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function readClockDevice(employmentId:string){
  const owner=epoch;
  await writes;
  const raw=await SecureStore.getItemAsync(KEY,STORE);
  if(owner!==epoch||!raw)return null;
  try{const value=JSON.parse(raw);return value.employmentId===employmentId&&typeof value.token==='string'&&uuid.test(value.token)?value.token:null;}catch{return null;}
}
export function writeClockDevice(employmentId:string,token:string,assertCurrent:()=>void){
  const owner=epoch;
  const next=writes.then(async()=>{assertCurrent();if(owner!==epoch)throw new Error('Registration cancelled');await SecureStore.setItemAsync(KEY,JSON.stringify({employmentId,token}),STORE);assertCurrent();});
  writes=next.catch(()=>undefined);return next;
}
export function clearClockDevice(){
  epoch++;
  const next=writes.then(()=>SecureStore.deleteItemAsync(KEY,STORE));writes=next.catch(()=>undefined);return next;
}
