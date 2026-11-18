type ReadGroupResult<T extends readonly (()=>unknown)[]>={
 -readonly [P in keyof T]:T[P] extends ()=>infer Value?Awaited<Value>:never;
};

/** A read group owns every child until it settles, including later IO phases.
 * Retain the original first observed failure. Register every independent read
 * even when another throws synchronously, so already-started shared promises
 * represented by later thunks are also drained. This is not a command runner. */
export async function settleReadGroup<T extends readonly (()=>unknown)[]|[]>(reads:T):Promise<ReadGroupResult<T>>{
 let failed=false,firstError:unknown;
 const fail=(error:unknown)=>{if(!failed){failed=true;firstError=error;}};
 const pending:Promise<unknown>[]=[];
 for(const read of reads){
  try{pending.push(Promise.resolve(read()).catch(error=>{fail(error);throw error;}));}
  catch(error){fail(error);}
 }
 const settled=await Promise.allSettled(pending);
 if(failed)throw firstError;
 return settled.map(result=>(result as PromiseFulfilledResult<unknown>).value) as ReadGroupResult<T>;
}
