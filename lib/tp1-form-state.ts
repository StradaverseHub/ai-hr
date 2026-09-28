/**
 * The TP1 declaration form's ACTION CONTRACT (r352, item 0df7dd44).
 *
 * Deliberately a file of its own, with NO imports. `components/tp1-form-client.tsx` is a `'use client'`
 * module and `app/**` `'use server'` files are the other side of the boundary; a shared type that lived in
 * either one would have the other importing across it for no runtime reason. `lib/tp1-form-input.ts` —
 * the form's other shared contract — cannot hold it either: it reaches `@/packs/payroll/service` for the
 * catalogue, and dragging the payroll pack into the client bundle to name a two-field object would be a
 * real cost for a type that erases.
 *
 * ── WHY THE ACTIONS RETURN A STATE INSTEAD OF REDIRECTING ───────────────────────────────────────────
 * Every TP1 write action used to `redirect()` on failure — and to the TP1 Relief LIST, not even to the
 * page the reader was on. The form is ~40 uncontrolled amount boxes; navigating away threw all of them
 * away and the reader arrived at a different screen with an error banner about a form they could no
 * longer see. That is item 0df7dd44 in one sentence.
 *
 * `useActionState` returns without navigating, so the form is never unmounted (the rationale is recorded
 * verbatim in components/claim-form.tsx, which is the house precedent). SUCCESS still redirects: a fresh
 * list plus a toast is the right outcome there, and it is what shipped.
 */

/** What an editable-TP1 action hands back to the form. `null` ⇒ nothing to say (it redirected instead). */
export type Tp1FormState = { error: string | null };

/**
 * A `useActionState`-shaped TP1 form action. ONE action per surface, with the pressed button's
 * `name="intent"` selecting Save draft / Submit / Submit-and-approve — a submitter's name and value are
 * part of the FormData the browser posts, so three buttons need neither three forms nor three hooks, and
 * there is exactly one error state to render.
 *
 * Discard is NOT one of these. It keys nothing and preserves nothing, so it stays the plain redirecting
 * action it has always been, on a button whose own `formAction` overrides the form's.
 */
export type Tp1FormAction = (prev: Tp1FormState, formData: FormData) => Promise<Tp1FormState>;

/** The values `intent` may carry. Anything else is treated as a plain Submit. */
export type Tp1FormIntent = 'draft' | 'submit' | 'submitApprove';
