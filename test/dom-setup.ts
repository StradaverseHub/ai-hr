/**
 * Setup for the `dom` project only (see vitest.config.ts). Deliberately NOT test/env.ts: a component test
 * needs no database URL and no env bootstrap, and giving it one would invite a DOM test to reach for a
 * connection it should not have.
 *
 * Unmounting between tests is not optional here. Testing Library renders into a container appended to
 * document.body, and jsdom keeps ONE document for every test in a file — so without cleanup the second
 * test in a file queries a DOM that still contains the first test's markup, and getByRole starts failing
 * with "found multiple elements" for reasons that have nothing to do with the component under test.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * jsdom implements no layout, so it ships NO Element.prototype.scrollIntoView at all — not a stub, the
 * method is simply absent. Any component that keeps an active option in view calls it in an effect, so the
 * first DOM test to open one dies with "scrollIntoView is not a function" from inside React's commit phase,
 * pointing at the component rather than at the environment. components/ui/combobox.tsx does exactly this
 * (and has since long before the test that first tripped over it), so the gap belongs here, once.
 *
 * A no-op is the honest stub: there is no layout to scroll and nothing to assert about a scroll that cannot
 * happen. The BEHAVIOUR is pinned by source assertion instead — see test/leave-type-workspace.test.ts, which
 * checks the call and its dependency list are still there. Do not "improve" this into a spy that tests
 * assert on; that would test jsdom, not the product.
 */
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

afterEach(() => {
  cleanup();
});
