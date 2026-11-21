import { NAVIGATION_START } from '@/lib/navigation-feedback';

export function onRouterTransitionStart(url: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_START, { detail: url }));
}
