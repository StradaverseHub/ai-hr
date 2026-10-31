/**
 * r256 (item 858a1128) — the C.P.8A (EA) picker's two searches, as one pure function.
 *
 * PURE AND OUTSIDE THE COMPONENT SO IT CAN BE TESTED WITHOUT A BROWSER. The reporter asked for a search on
 * employee NAME and a separate search on employee ID, and "does the employee-ID box actually match on the
 * employee ID" is a question a source-shape assertion cannot answer — it needs the function run over rows.
 *
 * TWO BOXES, ANDed. A name filter and a code filter narrow together, so typing in both is "this name AND
 * this id" rather than a union — which is what an operator hunting one person in a list of four hundred
 * expects. They are separate boxes rather than one combined search because the reporter asked for two, and
 * because "A0001" typed into a box that also matched names would quietly return people whose names contain
 * it.
 *
 * CASE-INSENSITIVE AND SUBSTRING on both, and trimmed: an employee ID pasted from a spreadsheet arrives
 * with whitespace, and "a0001" must find "A0001".
 */
export type EaSearchable = { name: string; code: string };

export function filterEaRows<T extends EaSearchable>(
  rows: readonly T[],
  q: { name?: string; code?: string },
): T[] {
  const n = (q.name ?? '').trim().toLocaleLowerCase();
  const c = (q.code ?? '').trim().toLocaleLowerCase();
  if (!n && !c) return [...rows];
  return rows.filter(
    (r) =>
      (!n || r.name.toLocaleLowerCase().includes(n)) && (!c || r.code.toLocaleLowerCase().includes(c)),
  );
}
