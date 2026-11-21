/** Pure terminal proof state, not native evidence or authority. Every instance
 * starts false and accepts no previously reported booleans or JSON witness. */
type Kind='prototype'|'logging';
export function employeeChoiceAsciiTerminalWitness(){
 const started=new Set<Kind>(),accepted={prototype:false,logging:false};let failed=false;
 const snapshot=()=>({...accepted,complete:!failed&&accepted.prototype&&accepted.logging});
 return{snapshot,
  prove(kind:Kind,guard:()=>Promise<void>){
   if(kind!=='prototype'&&kind!=='logging')throw Error('Closed terminal witness required');
   if(started.has(kind))throw Error('Terminal native guard already attempted');started.add(kind);accepted[kind]=false;
   return Promise.resolve().then(guard).then(()=>{accepted[kind]=true;},error=>{failed=true;throw error;});
  },
 };
}
