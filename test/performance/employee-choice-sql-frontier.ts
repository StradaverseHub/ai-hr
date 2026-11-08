/** Pure verification statement-frontier mechanics, no database imports. */
/** Preserve postgres' complete typed surface; only statement/transaction admission
 * is wrapped. SQL strings, values, return types and native transactions are intact. */
export function employeeChoiceSqlFrontier<T extends object>(client:T,admit:()=>void,own:<V>(create:()=>V|PromiseLike<V>)=>Promise<V>=create=>Promise.resolve().then(create),watch:<V>(operation:Promise<V>)=>Promise<V>=operation=>operation,nativeFailure:(error:unknown)=>void=()=>{}):T{
 return new Proxy(client,{
  apply(target,self,args){admit();if(typeof target!=='function')throw Error('Callable SQL carrier required');const result:unknown=Reflect.apply(target,self,args);return result&&typeof result==='object'?employeeChoiceReadFrontier(result,admit,nativeFailure):result;},
  get(target,key,receiver){
   const value=Reflect.get(target,key,receiver);
   if(typeof value!=='function'||!['unsafe','begin','savepoint','reserve','notify','file'].includes(String(key)))return value;
   return(...args:unknown[])=>{
    admit();if(['reserve','notify','file'].includes(String(key)))throw Error('Noncanonical benchmark SQL carrier refused');
    const wrapped=args.map(arg=>typeof arg==='function'?(tx:object)=>{admit();return own(()=>{const result:unknown=Reflect.apply(arg,undefined,[employeeChoiceSqlFrontier(tx,admit,own,watch,nativeFailure)]);return Array.isArray(result)?Promise.all(result):result;});}:arg);
    const result:unknown=Reflect.apply(value,target,wrapped);if(key==='begin'||key==='savepoint')return watch(Promise.resolve(result));return key==='unsafe'&&result&&typeof result==='object'?employeeChoiceReadFrontier(result,admit,nativeFailure):result;
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
export function employeeChoiceReadFrontier<T extends object>(root:T,admit:()=>void,nativeFailure?:(error:unknown)=>void):T{
 const owned=new WeakMap<object,object>();
 const wrap=<V extends object>(value:V):V=>{
  const known=owned.get(value);if(known)return known as V;
  const proxy=new Proxy(value,{get(target,key){
   const member=Reflect.get(target,key,target);if(typeof member!=='function')return member;
   return(...args:unknown[])=>{
    admit();
    if(nativeFailure&&['cursor','forEach','stream','readable','writable'].includes(String(key)))throw Error('Unowned streaming benchmark callback refused');
    if(nativeFailure&&['then','catch','finally'].includes(String(key))){
     const then=Reflect.get(target,'then',target);if(typeof then!=='function')throw Error('Native query then required');
     const handler=args[key==='catch'?0:1],finalizer=args[0];
     const rejected=(error:unknown)=>{nativeFailure(error);if(key==='finally'||typeof handler!=='function')throw error;return Reflect.apply(handler,undefined,[error]);};
     const observed:Promise<unknown>=Reflect.apply(then,target,[key==='then'?args[0]:undefined,rejected]);
     return key==='finally'?observed.finally(typeof finalizer==='function'?()=>Reflect.apply(finalizer,undefined,[]):undefined):observed;
    }
    const mapped=key==='transaction'?args.map(arg=>typeof arg==='function'?(tx:object)=>{admit();return Reflect.apply(arg,undefined,[wrap(tx)]);}:arg):args;
    const result:unknown=Reflect.apply(member,target,mapped);
    if(result&&typeof result==='object'&&!Array.isArray(result))return wrap(result);
    return result;
   };
  }});owned.set(value,proxy);return proxy;
 };
 return wrap(root);
}

/** Track the actual callback, not only postgres.begin's connection-close race.
 * Its original caller retains the outcome; this registry owns quiescence. */
export function employeeChoiceWorkRegistry(){
 const pending=new Set<Promise<unknown>>(),acknowledged=new Set<unknown>(),nativeQueryFailures=new Set<unknown>(),notInvoked=new Set<unknown>(),failures:unknown[]=[];let admitted=0,settled=0,stopped=false;
 const transport=(error:unknown)=>error instanceof Error&&!(error instanceof AggregateError)&&['CONNECTION_DESTROYED','CONNECTION_CLOSED'].includes(Reflect.get(error,'code'));
 const own=<T>(create:()=>T|PromiseLike<T>,admit:()=>void=()=>{}):Promise<T>=>{
  const operation=Promise.resolve().then(()=>{try{admit();}catch(error){notInvoked.add(error);throw error;}return create();});pending.add(operation);admitted++;
  void operation.then(()=>{settled++;pending.delete(operation);},error=>{settled++;failures.push(error);pending.delete(operation);});return operation;
 };
 const watch=<T>(operation:Promise<T>):Promise<T>=>operation.then(value=>value,error=>{acknowledged.add(error);throw error;});
 return{own,watch,nativeFailure(error:unknown){nativeQueryFailures.add(error);},stop(){stopped=true;},async settle(){
  while(pending.size)await Promise.allSettled([...pending]);
  const outerClose=stopped&&[...acknowledged].some(transport);
  const unobserved=failures.filter(error=>!acknowledged.has(error)&&!notInvoked.has(error)&&!(outerClose&&nativeQueryFailures.has(error)&&transport(error)));
  if(unobserved.length)throw new AggregateError(unobserved,'Native transaction returned before distinct callback failures drained');
  return{admitted,settled,rejected:failures.length,pending:pending.size};
 }};
}
