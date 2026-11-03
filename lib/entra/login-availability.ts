import { readBoundedBody } from '../bounded-body';
/** Public presentation only. Server login admission independently enforces the switch. */
export function watchMicrosoftLogin(organization:string,origin:string|null,fetcher:typeof fetch,onResult:(enabled:boolean)=>void) {
  const code=organization.trim().toLowerCase();
  if(origin===null||!/^[a-z0-9][a-z0-9-]{1,63}$/.test(code))return;
  let stopped=false,request:AbortController|undefined;
  const check=async()=>{
    request?.abort();const current=new AbortController();request=current;
    const timeout=setTimeout(()=>current.abort(),5000);
    let enabled=false;
    try{
      const response=await fetcher(origin+'/login/entra/options?'+new URLSearchParams({organization:code}),{
        credentials:'omit',redirect:'error',cache:'no-store',signal:current.signal,
      });
      if(response.ok){
        const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(response,512,5000,current.signal)));
        enabled=data?.microsoft===true;
      }
    }catch{/* Keep local login usable when discovery is unavailable. */}
    finally{clearTimeout(timeout);}
    if(!stopped&&request===current&&!current.signal.aborted)onResult(enabled);
    else if(!stopped&&request===current)onResult(false);
  };
  const start=setTimeout(()=>void check(),250),poll=setInterval(()=>void check(),30000);
  const focus=()=>void check();
  if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('focus',focus);
  return ()=>{stopped=true;clearTimeout(start);clearInterval(poll);request?.abort();if(typeof window!=='undefined'&&typeof window.removeEventListener==='function')window.removeEventListener('focus',focus);};
}
