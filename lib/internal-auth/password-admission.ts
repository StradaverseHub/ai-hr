/** Same two memory-hard hashes at once. Absorb only the remaining six requests that the
 * auth route's existing eight-request admission could already hold; never grow an unbounded queue. */
export class AuthBusyError extends Error {}
type Release=()=>void;
export function createPasswordAdmission(){
 let active=0;
 const waiting:{resolve:(release:Release)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
 const lease=():Release=>{
  let released=false;
  return()=>{
   if(released)return;released=true;
   const next=waiting.shift();
   if(next){clearTimeout(next.timer);next.resolve(lease());}
   else active--;
  };
 };
 return():Promise<Release>=>{
  if(active<2){active++;return Promise.resolve(lease());}
  if(waiting.length>=6)return Promise.reject(new AuthBusyError('Authentication busy. Try again shortly.'));
  return new Promise<Release>((resolve,reject)=>{
   const entry={resolve,timer:setTimeout(()=>{
    const index=waiting.indexOf(entry);if(index<0)return;
    waiting.splice(index,1);reject(new AuthBusyError('Authentication busy. Try again shortly.'));
   },2000)};
   waiting.push(entry);
  });
 };
}
