/** Accept only the assessment workspace and a small set of scalar selectors; never an arbitrary redirect. */
export function assessmentReturnPath(raw:unknown,fallback:string):string {
 if(typeof raw!=='string'||!raw.startsWith('/performance/workspace?'))return fallback;
 const input=new URL(raw,'https://local.invalid'),params=new URLSearchParams();
 if(input.pathname!=='/performance/workspace'||input.origin!=='https://local.invalid')return fallback;
 for(const key of ['cycle','view','module','review','feedback','calibration','stage']){
  const value=input.searchParams.get(key);if(value&&value.length<=100)params.set(key,value);
 }
 return `/performance/workspace?${params}`;
}
