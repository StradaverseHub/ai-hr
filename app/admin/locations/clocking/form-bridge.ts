/**
 * fa2db8cb rev 2 (r279) — HOW THE TWO MAP ISLANDS TALK TO THE SERVER-RENDERED FORM, and to each other.
 *
 * THE FORM IS THE ONE SOURCE OF TRUTH FOR THE VALUES. `clocking-form.tsx` stays a server component with
 * uncontrolled `defaultValue` inputs (that is what lets a refused save echo everything typed back into
 * it), so the islands do NOT own `address`, `lat`, `lng` or `radiusM` and must never mirror them into
 * React state. The address search WRITES those inputs; the map READS them and listens for changes. Two
 * views of one set of inputs can never disagree about what is about to be posted — which is the same
 * rule `components/attendance/location-assignment.tsx` follows with its one `Set`.
 *
 * WHY NOT PROPS AND CALLBACKS. The obvious shape — lift the values into a client parent and pass
 * setters down — would mean either moving the four inputs into a client island (breaking the echo
 * contract in ./form-fields.ts and the field-placement guards that pin it) or passing functions across
 * the server→client boundary. r272 shipped a 500 doing the latter: tsc, eslint and thirteen source
 * guards were green and the page still failed to render with "Functions cannot be passed directly to
 * Client Components". Nothing in this round crosses that boundary except strings, numbers and nulls.
 *
 * A plain module with no directive. It is imported ONLY by the two 'use client' islands, so it is part
 * of the client graph; it touches no Next API and no environment, and every function below returns
 * harmlessly when the DOM is not what it expected (the form re-renders on soft navigation, and an
 * island's effect can run a tick after its host has gone).
 */

/** The `<form>` an island is rendered inside, found from any node it owns. Null before mount. */
export function ownerForm(node: HTMLElement | null | undefined): HTMLFormElement | null {
  return node?.closest('form') ?? null;
}

/** One named field of that form, when it is a single text-ish control. Anything else reads as absent. */
function field(form: HTMLFormElement | null, name: string): HTMLInputElement | HTMLTextAreaElement | null {
  const el = form?.elements.namedItem(name) ?? null;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

/** The raw string currently in a field — never a number: the form posts raw strings and so does this. */
export function fieldValue(form: HTMLFormElement | null, name: string): string {
  return field(form, name)?.value ?? '';
}

/**
 * Write a field and TELL THE PAGE. A plain `el.value = x` updates the DOM but fires no event, so the
 * map would never learn that the search had just moved the point. The synthetic `input` event bubbles
 * to the form, which is where the map listens.
 */
export function setFieldValue(form: HTMLFormElement | null, name: string, value: string): void {
  const el = field(form, name);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * "The point was deliberately MOVED, not nudged" — dispatched by the address search after it has
 * written address / lat / lng, and listened for by the map, which reframes the view around the new
 * circle instead of merely panning. A DOM event rather than a prop: the two islands are siblings in a
 * server-rendered tree and have no shared React parent to hold state for them.
 */
export const MAP_FOCUS_EVENT = 'clocking-map:focus';

export function requestMapFocus(form: HTMLFormElement | null): void {
  form?.dispatchEvent(new CustomEvent(MAP_FOCUS_EVENT, { bubbles: false }));
}

/** A point only when BOTH boxes hold a real, in-range number — a half-typed "3." is not a location. */
export function readPoint(form: HTMLFormElement | null): { lat: number; lng: number } | null {
  const latRaw = fieldValue(form, 'lat').trim();
  const lngRaw = fieldValue(form, 'lng').trim();
  if (latRaw === '' || lngRaw === '') return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The radius to draw, in metres. Zero means "draw nothing": a blank or nonsense radius is left for
 * `cleanRadius` (core/clocking-location.ts) to refuse in plain English on save — the map's job is to
 * show what is there, never to invent a default the operator did not type. The 200 km ceiling is a
 * drawing limit, not a rule: a circle wider than that is an unusable picture, and the service's own
 * 10–5000 m advisory is the thing that actually talks to the operator about the number.
 */
export function readRadiusM(form: HTMLFormElement | null): number {
  const raw = fieldValue(form, 'radiusM').trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 200_000);
}
