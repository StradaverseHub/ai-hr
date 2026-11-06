/** Static fleet budget; every web process must receive the same worker count and total. */
export function applicationDatabaseBudget(env: Record<string,string|undefined>) {
  function integer(key:string,fallback:number,min:number,max:number) {
    const raw=env[key];
    if(raw===undefined)return fallback;
    if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return Number(raw);
  }
  const poolMax=integer('AIHR_DB_POOL_MAX',10,1,50);
  if((env.AIHR_APP_WORKERS===undefined)!==(env.AIHR_DB_TOTAL_CONNECTIONS===undefined))
    throw new Error('Declare both AIHR_APP_WORKERS and AIHR_DB_TOTAL_CONNECTIONS for a shared application budget.');
  const workers=integer('AIHR_APP_WORKERS',1,1,64);
  const totalConnections=integer('AIHR_DB_TOTAL_CONNECTIONS',poolMax,1,1000);
  if(poolMax*workers>totalConnections)throw new Error('Application workers exceed AIHR_DB_TOTAL_CONNECTIONS.');
  return {poolMax,workers,totalConnections,maxWaiting:Math.floor(2048/workers),waitMs:30_000};
}
