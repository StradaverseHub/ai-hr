/**
 * The feedback board's ordering vocabulary (e14334ef) — shared by the SERVER page that validates
 * `?sort=` and issues the query, and the CLIENT table that renders the clickable heading.
 *
 * WHY IT IS NOT IN `core/feedback.ts`. `app/feedback/bulk-table.tsx` is a `'use client'` module and has
 * to know the two option names to build the flip link. It already imports `FeedbackRow` from core, but
 * that is a TYPE import and erases; importing a runtime constant from core would pull the drizzle client
 * and the whole DB layer into the browser bundle. So the vocabulary lives here, dependency-free, and
 * `core/feedback.ts` imports the type from it.
 *
 * WHY THE ORDER IS SERVER-SIDE AT ALL. `listFeedback` caps the board at 200 rows (517 on production).
 * Sorting the returned page in the browser would rank only the 200 most recently CREATED items, so an
 * old item touched yesterday — the exact case this field exists to surface — could never reach the top.
 * The ORDER BY has to run before the LIMIT, which means it has to run in SQL.
 */

/** Newest-touched first (the board's opening order) and its reverse. */
export const FEEDBACK_SORTS = ['updated_desc', 'updated_asc'] as const;
export type FeedbackSort = (typeof FEEDBACK_SORTS)[number];

/**
 * The board opens most-recently-touched first. This REPLACED `created_at desc` (e14334ef): the reporter
 * asked to see what the loop has moved since they last looked, and creation order answers a different
 * question — an item raised in March and deployed this morning sat 300 rows down.
 */
export const DEFAULT_FEEDBACK_SORT: FeedbackSort = 'updated_desc';

/** Coerce a raw `?sort=` value to a known option; anything else (absent, junk, an array) → the default. */
export function parseFeedbackSort(raw: string | string[] | undefined): FeedbackSort {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (FEEDBACK_SORTS as readonly string[]).includes(v ?? '') ? (v as FeedbackSort) : DEFAULT_FEEDBACK_SORT;
}

/** What clicking the Last Updated heading should switch to. */
export function flipFeedbackSort(sort: FeedbackSort): FeedbackSort {
  return sort === 'updated_desc' ? 'updated_asc' : 'updated_desc';
}
