import { notFound } from 'next/navigation';

/**
 * With separate (auth)/(app) root layouts there is no top-level layout, so Next.js would answer an unmatched
 * URL with its bare built-in 404. Matching it here keeps that 404 inside this shell (and behind its session
 * gate), as it was with the single root layout. Every real route is more specific and wins.
 */
export default function MissingPage(): never {
  notFound();
}
