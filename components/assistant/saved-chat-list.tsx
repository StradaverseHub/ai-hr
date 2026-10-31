"use client";
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {loadMoreChatsAction} from '../../app/assistant/launcher-actions';
import {observeChatListUpdates} from './chat-list-updates';
type Chat={threadId:string;exchangeId:string;title:string};
/** Earlier scan pages may repeat a long chat. Preserve the newest/first selected tail per thread. */
function distinct(rows:readonly Chat[]):Chat[]{const seen=new Set<string>();return rows.filter(row=>{if(seen.has(row.threadId))return false;seen.add(row.threadId);return true;});}
export function SavedChatList({initialChats,nextCursor,scopeDigest,activeThreadId,newChatHref}:{initialChats:readonly Chat[];nextCursor:string|null;scopeDigest:string;activeThreadId?:string;newChatHref:string}){
 const t=useTranslations('assistant.workspace.chat');
 const [chats,setChats]=useState(()=>distinct(initialChats)),[cursor,setCursor]=useState(nextCursor),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const epoch=useRef(0),busy=useRef(false),alive=useRef(true);
 // The server issues a fresh New-chat nonce on each authoritative render, including erasure.
 const signature=JSON.stringify([scopeDigest,nextCursor,initialChats,newChatHref]);
 useEffect(()=>{epoch.current++;busy.current=false;setPending(false);setChats(distinct(initialChats));setCursor(nextCursor);setError(null);},[signature]); // eslint-disable-line react-hooks/exhaustive-deps
 // Only the summaries change after an ask; the visible transcript and route stay mounted.
 useEffect(()=>observeChatListUpdates(scopeDigest,page=>{epoch.current++;busy.current=false;setPending(false);setChats(distinct(page.chats));setCursor(page.nextCursor);setError(null);}),[signature,scopeDigest]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 async function more(){if(!cursor||busy.current)return;busy.current=true;setPending(true);setError(null);const at=epoch.current;
  try{const page=await loadMoreChatsAction({cursor});if(!alive.current||at!==epoch.current)return;
   if(!page.ok){setError(page.message);return;}if(page.scopeDigest!==scopeDigest){setError(t('readOnlyHistory'));return;}
   setChats(rows=>distinct([...rows,...page.chats]));setCursor(page.nextCursor);
  }catch{if(alive.current&&at===epoch.current)setError(t('readOnlyHistory'));}finally{if(alive.current&&at===epoch.current){busy.current=false;setPending(false);}}
 }
 return <nav aria-label={t('chats')} className="pb-3"><h2 className="py-3 text-sm font-medium">{t('chats')}</h2>
  <Link href={newChatHref} scroll={false} className="mb-2 inline-flex min-h-11 items-center rounded-md px-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('new')}</Link>
  <ul className="max-h-80 space-y-1 overflow-y-auto overscroll-contain">{chats.map(chat=><li key={chat.threadId}><Link href={'/assistant?e='+encodeURIComponent(chat.exchangeId)} scroll={false} aria-current={activeThreadId===chat.threadId?'page':undefined} className="block break-words rounded-md px-2 py-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-[current=page]:bg-muted">{chat.title}</Link></li>)}</ul>
  {cursor&&<button type="button" disabled={pending} onClick={()=>void more()} className="inline-flex min-h-11 items-center px-2 text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{t('moreChats')}</button>}
  {error&&<p role="status" className="py-2 text-xs text-muted-foreground">{error}</p>}
 </nav>;
}
