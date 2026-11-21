/** The saved-history navigation owner reports actual hydration, not an unrelated page readiness signal. */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup} from '@testing-library/react';
import {hydrateRoot} from 'react-dom/client';
import {renderToString} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SavedChatList} from '../components/assistant/saved-chat-list';
vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
vi.mock('../app/assistant/launcher-actions',()=>({loadMoreChatsAction:()=>{throw Error('No history mutation or paging is called by this readiness test.');}}));
afterEach(cleanup);
it('keeps the real saved-chat anchor and marks its own navigation only after client commit',async()=>{
 const node=<NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}><SavedChatList embedded initialChats={[{threadId:'owned-thread',exchangeId:'owned-leaf',title:'Fictional owned title'}]} nextCursor={null} scopeDigest="owned-scope" activeThreadId="owned-thread" newChatHref="/assistant?chatReset=new"/></NextIntlClientProvider>;
 const container=document.createElement('div');container.innerHTML=renderToString(node);document.body.append(container);const nav=container.querySelector('nav')!,anchor=nav.querySelector('a')!;
 expect(nav.getAttribute('data-ai-saved-chats-ready')).toBe('false');expect(anchor.getAttribute('href')).toBe('/assistant?e=owned-leaf');
 let root:ReturnType<typeof hydrateRoot>|undefined;await act(async()=>{root=hydrateRoot(container,node);});
 expect(container.querySelector('nav')).toBe(nav);expect(nav.querySelector('a')).toBe(anchor);expect(nav.getAttribute('data-ai-saved-chats-ready')).toBe('true');expect(anchor.getAttribute('aria-current')).toBe('page');expect(anchor.hasAttribute('aria-disabled')).toBe(false);
 await act(async()=>root!.unmount());container.remove();
});
