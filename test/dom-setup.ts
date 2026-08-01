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

afterEach(() => {
  cleanup();
});
