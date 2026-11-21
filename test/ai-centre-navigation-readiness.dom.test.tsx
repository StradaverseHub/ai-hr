import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {hydrateRoot} from 'react-dom/client';
import {renderToString} from 'react-dom/server';
import {CentreNavigationLink} from '../components/ai-centre/centre-navigation-link';

vi.mock('next/navigation',()=>({usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
afterEach(cleanup);
it('marks the actual native anchor only after hydration, retaining its existing link attributes',async()=>{
 const node=<CentreNavigationLink href="/assistant?view=jobs" aria-current="page" prefetch={false}>Jobs</CentreNavigationLink>;
 const container=document.createElement('div');container.innerHTML=renderToString(node);document.body.append(container);
 const anchor=container.querySelector('a')!;expect(anchor.getAttribute('data-ai-centre-link-ready')).toBe('false');
 let root:ReturnType<typeof hydrateRoot>|undefined;
 await act(async()=>{root=hydrateRoot(container,node);});
 expect(container.querySelector('a')).toBe(anchor);expect(anchor.getAttribute('data-ai-centre-link-ready')).toBe('true');
 expect(anchor.getAttribute('href')).toBe('/assistant?view=jobs');expect(anchor.getAttribute('aria-current')).toBe('page');
 await act(async()=>{root!.unmount();});container.remove();
});
it('keeps plain footer link click behavior and accessibility without disabling navigation',()=>{
 const clicked=vi.fn();
 const view=render(<CentreNavigationLink intent={false} href="/assistant?view=privacy" target="_self" onClick={event=>{event.preventDefault();clicked();}}>Privacy</CentreNavigationLink>);
 const anchor=view.getByRole('link',{name:'Privacy'});expect(anchor.getAttribute('data-ai-centre-link-ready')).toBe('true');
 expect(anchor.getAttribute('target')).toBe('_self');expect(anchor.hasAttribute('aria-disabled')).toBe(false);
 fireEvent.click(anchor);expect(clicked).toHaveBeenCalledTimes(1);
});
