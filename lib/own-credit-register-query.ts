import { CREDIT_REGISTER_STATUSES, type CreditRegisterStatus } from './leave-credit-register';
import { parsePageQuery } from './pagination';
const date=(v:string|undefined)=>!v||(/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
export function ownCreditRegisterQuery(sp:Record<string,string|string[]|undefined>) {
  const allowed=new Set(['status','from','to','page','size']);
  const invalid=Object.entries(sp).some(([key,value])=>!allowed.has(key)||Array.isArray(value));
  const scalar=(key:string)=>typeof sp[key]==='string'?sp[key] as string:undefined;
  const status=scalar('status'),from=scalar('from'),to=scalar('to');
  return { valid:!invalid&&(!status||(CREDIT_REGISTER_STATUSES as readonly string[]).includes(status))&&date(from)&&date(to)&&(!from||!to||from<=to),
    filters:{status:(status||undefined) as CreditRegisterStatus|undefined,from:from||undefined,to:to||undefined},
    query:parsePageQuery({page:scalar('page'),size:scalar('size')}) };
}
