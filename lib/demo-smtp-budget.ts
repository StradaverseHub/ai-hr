// Per-process limits. Demo users can switch identities, so the installation process also has a ceiling.
export function createDemoSmtpBudget(now:()=>number=Date.now){
  let active=0;
  const activeActors=new Set<string>();
  const attempts=new Map<string,number[]>();
  return {acquire(actor:string):(()=>void)|null {
    const time=now();
    for(const [key,times] of attempts){const live=times.filter(t=>time-t<60000);if(live.length)attempts.set(key,live);else attempts.delete(key);}
    const personal=attempts.get(actor)??[],all=attempts.get('*')??[];
    if(active>=2||activeActors.has(actor)||personal.length>=6||all.length>=12)return null;
    attempts.set(actor,[...personal,time]);attempts.set('*',[...all,time]);active++;activeActors.add(actor);
    let released=false;return ()=>{if(!released){released=true;active--;activeActors.delete(actor);}};
  }};
}
const globalBudget=globalThis as typeof globalThis & {__aihrDemoSmtpBudget?:ReturnType<typeof createDemoSmtpBudget>};
export const demoSmtpBudget=globalBudget.__aihrDemoSmtpBudget??=createDemoSmtpBudget();
