/** Today (AI v2 Phase 1, W3): carrying the question typed in Today's Ask bar to AI Centre Ask.
 *
 * The question never goes into the address: a URL lands in browser history, server logs and referrers, and a
 * question can be about a sensitive matter whose words are never stored (ADR-0169 §9). It is held in this tab's
 * sessionStorage for the one navigation, then read once and removed by the Ask page, which sends it through
 * the existing conversation command (app/assistant/launcher-actions.ts) as if the person had typed it there.
 * A handoff older than HANDOFF_TTL_MS, or read anywhere but the Ask page, is dropped unsent.
 *
 * Pure apart from the storage passed in, so it can be tested without a browser. */
export const ASK_HANDOFF_KEY='aihr.today.ask';
export const HANDOFF_TTL_MS=30_000;
/** core/assistant.ts refuses longer questions; the composers cap at the same length. */
export const MAX_HANDOFF_CHARS=2000;
export const ASK_PATH='/assistant';

type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

/** Keeps the question for the next Ask page load. Returns false when there is nothing to keep or no storage. */
export function storeAskHandoff(storage:Store|null|undefined,question:string,now:number=Date.now()):boolean{
 const text=question.trim().slice(0,MAX_HANDOFF_CHARS);
 if(!storage||!text)return false;
 try{storage.setItem(ASK_HANDOFF_KEY,JSON.stringify({q:text,at:now}));return true;}catch{return false;}
}

/** Reads and removes the handoff. Only the Ask page (no other view, saved chat or exchange open) accepts it,
 * and only while it is fresh; anything else is removed and nothing is returned. */
export function takeAskHandoff(storage:Store|null|undefined,location:Readonly<{pathname:string;search:string}>,now:number=Date.now()):string|null{
 if(!storage)return null;
 let raw:string|null=null;
 try{raw=storage.getItem(ASK_HANDOFF_KEY);if(raw!==null)storage.removeItem(ASK_HANDOFF_KEY);}catch{return null;}
 if(raw===null||location.pathname!==ASK_PATH)return null;
 const params=new URLSearchParams(location.search);
 if(['view','e','chat','job','governed','proposal'].some(name=>params.has(name)))return null;
 try{
  const value=JSON.parse(raw) as unknown;
  if(!value||typeof value!=='object')return null;
  const {q,at}=value as {q?:unknown;at?:unknown};
  if(typeof q!=='string'||typeof at!=='number'||!Number.isFinite(at))return null;
  if(now-at<0||now-at>HANDOFF_TTL_MS)return null;
  const text=q.trim();
  return text&&text.length<=MAX_HANDOFF_CHARS?text:null;
 }catch{return null;}
}
