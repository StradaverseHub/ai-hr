/** Refresh persisted catalogue rows after an import without discarding unsaved grid edits. */
export function refreshEditableRows<T extends { id: string; isNew: boolean; dirty: boolean }>(current: T[], incoming: T[]): T[] {
  const edited = new Map(current.filter(row => !row.isNew && row.dirty).map(row => [row.id, row]));
  const incomingIds = new Set(incoming.map(row => row.id));
  return [
    ...incoming.map(row => edited.get(row.id) ?? row),
    ...current.filter(row => row.isNew || row.dirty && !incomingIds.has(row.id)),
  ];
}
