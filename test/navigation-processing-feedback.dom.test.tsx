import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {NavigationFeedback} from '@/components/navigation-feedback';
import {onRouterTransitionStart} from '@/instrumentation-client';
const route=vi.hoisted(()=>({pathname:'/personnel',query:''}));
vi.mock('next/navigation',()=>({usePathname:()=>route.pathname,useSearchParams:()=>new URLSearchParams(route.query)}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>key)}));
afterEach(()=>{cleanup();vi.useRealTimers();route.pathname='/personnel';route.query='';document.documentElement.removeAttribute('data-ui-theme');});
describe('honest route processing feedback',()=>{
 it.each(['classic','monolith','atelier'])('tracks Edit route loading in %s without announcing a mutation outcome',theme=>{
  vi.useFakeTimers();document.documentElement.dataset.uiTheme=theme;const view=render(<NavigationFeedback/>);
  act(()=>{onRouterTransitionStart('/personnel/edit');vi.advanceTimersByTime(121);});const status=screen.getByRole('status');expect(status).toHaveAttribute('data-pending','navigate');expect(status).toHaveAttribute('aria-busy','true');expect(status).toHaveTextContent('loading');expect(status).toHaveClass('action-navigation-feedback');
  act(()=>vi.advanceTimersByTime(20_000));expect(status).toHaveAttribute('aria-busy','true');expect(status).toHaveTextContent('actionFeedback.navigationUnconfirmed');
  route.pathname='/personnel/edit';view.rerender(<NavigationFeedback/>);expect(status).toHaveAttribute('aria-busy','false');expect(status).not.toHaveAttribute('data-pending');expect(status).toHaveTextContent('');
 });
 it('keeps filter navigation separate from action success and ignores toast cleanup or hash-only changes',()=>{
  vi.useFakeTimers();route.query='status=active&toast=Saved';render(<NavigationFeedback/>);
  act(()=>{onRouterTransitionStart('/personnel?status=active#employee');vi.advanceTimersByTime(121);});expect(screen.getByRole('status')).not.toHaveAttribute('data-pending');
  act(()=>{onRouterTransitionStart('/personnel?status=draft');vi.advanceTimersByTime(121);});expect(screen.getByRole('status')).toHaveAttribute('data-pending','filter');
 });
});
