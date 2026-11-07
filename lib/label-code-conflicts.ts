/** Return every changed row whose normalized code is already in use in its uniqueness scope. */
export function labelCodeConflicts(
  rows: {key: string; code: string; scope: string; changed: boolean}[],
): string[] {
  const counts = new Map<string, number>();
  const identity = (row: (typeof rows)[number]) => JSON.stringify([row.scope, row.code]);
  for (const row of rows) {
    if (!row.code) continue;
    const id = identity(row);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return rows.filter(row => row.changed && row.code && (counts.get(identity(row)) ?? 0) > 1)
    .map(row => row.key);
}
