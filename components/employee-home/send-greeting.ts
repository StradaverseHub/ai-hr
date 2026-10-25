import type {HomeGreetingCommand} from '@/lib/employee-home-greeting';
/** Explicit click adapter only. Do not retry an uncertain response or mint another nonce here. */
export async function sendHomeGreetingCommand(command:Readonly<HomeGreetingCommand>):Promise<unknown>{
 const response=await fetch('/api/home/greetings',{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
 if(!response.ok)throw Error('Greeting delivery unconfirmed');
 return response.json();
}
