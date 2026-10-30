/** Per-process application capacity. Keep all replicas within the database connection budget. */
export function applicationPoolMax(raw:string|undefined):number{
  if(raw==null||raw==='')return 10;
  if(!/^[1-9]\d*$/.test(raw)||Number(raw)>40)throw new RangeError('AIHR_DB_POOL_MAX must be an integer from 1 to 40');
  return Number(raw);
}
