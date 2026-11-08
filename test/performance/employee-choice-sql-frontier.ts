/** Pure verification statement-frontier mechanics, no database imports. */
/** Preserve postgres' complete typed surface; only statement/transaction admission
 * is wrapped. SQL strings, values, return types and native transactions are intact. */
export function employeeChoiceSqlFrontier<T extends object>(client:T,admit:()=>void):T{
 return new Proxy(client,{
  apply(target,self,args){admit();const result:unknown=Reflect.apply(target as Function,self,args);return result&&typeof result==='object'?employeeChoiceReadFrontier(result,admit):result;},
  get(target,key,receiver){
   const value=Reflect.get(target,key,receiver);
   if(typeof value!=='function'||!['unsafe','begin','savepoint','reserve','notify','file'].includes(String(key)))return value;
   return(...args:unknown[])=>{
    admit();if(['reserve','notify','file'].includes(String(key)))throw Error('Noncanonical benchmark SQL carrier refused');
    const wrapped=args.map(arg=>typeof arg==='function'?(tx:object)=>{admit();return Reflect.apply(arg,undefined,[employeeChoiceSqlFrontier(tx,admit)]);}:arg);
    const result:unknown=Reflect.apply(value,target,wrapped);return key==='unsafe'&&result&&typeof result==='object'?employeeChoiceReadFrontier(result,admit):result;
   };
  },
 });
}
/** Record every close capability before the first resource await. Late adoption
 * after stop immediately closes, and remains owned until final settle(). */
export function employeeChoiceCloseRegistry(){
 let stopped=false;const closes:(()=>Promise<void>)[]=[];
 const register=(close:()=>Promise<void>)=>{
  let pending:Promise<void>|undefined;
  const owned=()=>{if(!pending){pending=Promise.resolve().then(close);void pending.catch(()=>{});}return pending;};
  closes.push(owned);if(stopped)void owned();return owned;
 };
 const settle=async()=>{
  let observed=0;const errors:unknown[]=[];
  while(observed<closes.length){const batch=closes.slice(observed);observed=closes.length;
   for(const value of await Promise.allSettled(batch.map(close=>close())))if(value.status==='rejected')errors.push(value.reason);}
  if(errors.length)throw new AggregateError(errors,'Benchmark registered resource settlement refused');
 };
 return{register,settle,stop(){stopped=true;return settle();},get stopped(){return stopped;}};
}
/** Guard public Drizzle query-builder calls AND lazy then execution. Results
 * resolve through the original thenable unwrapped; DTO rows are never proxied. */
export function employeeChoiceReadFrontier<T extends object>(root:T,admit:()=>void):T{
 const owned=new WeakMap<object,object>();
 const wrap=<V extends object>(value:V):V=>{
  const known=owned.get(value);if(known)return known as V;
  const proxy=new Proxy(value,{get(target,key){
   const member=Reflect.get(target,key,target);if(typeof member!=='function')return member;
   return(...args:unknown[])=>{
    admit();const mapped=key==='transaction'?args.map(arg=>typeof arg==='function'?(tx:object)=>{admit();return Reflect.apply(arg,undefined,[wrap(tx)]);}:arg):args;
    const result:unknown=Reflect.apply(member,target,mapped);
    if(result&&typeof result==='object'&&!Array.isArray(result))return wrap(result);
    return result;
   };
  }});owned.set(value,proxy);return proxy;
 };
 return wrap(root);
}
