/**
 * r402 (item f3cf2444) — WHAT A PER-EMPLOYEE STATUTORY FORM'S VIEWER CARRIES, written once.
 *
 * The viewer frames the form's existing inline route, offers its existing download, switches its version
 * and returns to its picker — four URLs that MUST carry the same company, year, version and people, or the
 * document on screen is not the one the Download button saves. So all four are built from one query
 * string, here, and `test/r402-statutory-pdf-viewer.test.ts` pins the frame's source to the preview route
 * plus exactly these parameters.
 *
 * Pure. It validates SHAPE only (the routes run their own gate on every request, scope included); a page
 * that prints a company name must still check scope itself.
 */
import { MAX_EA_SELECTION } from './ea/limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ticked employments from a search param, shape-checked, de-duplicated, in the order they came. */
export function viewerIds(raw: string | string[] | undefined): string[] {
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(all.filter((id) => UUID.test(id)))].slice(0, MAX_EA_SELECTION);
}

export type ViewerParams = {
  companyId: string;
  year: string;
  lang: string;
  ids: string[];
  /** Form-specific parameters, carried in this order after `lang` (PCB 2(II)'s `selectedDate`). */
  extra?: { name: string; value: string }[];
};

/** The parameters as name/value pairs — the hidden inputs of the Version switch use the same list. */
export function viewerPairs(p: ViewerParams, opts: { withLang?: boolean } = {}): { name: string; value: string }[] {
  return [
    { name: 'companyId', value: p.companyId },
    { name: 'year', value: p.year },
    ...(opts.withLang === false ? [] : [{ name: 'lang', value: p.lang }]),
    ...(p.extra ?? []),
    ...p.ids.map((id) => ({ name: 'id', value: id })),
  ];
}

/** One query string for the frame, the download, the switch and Back. */
export function viewerQuery(p: ViewerParams): string {
  const q = new URLSearchParams();
  for (const { name, value } of viewerPairs(p)) q.append(name, value);
  return q.toString();
}
