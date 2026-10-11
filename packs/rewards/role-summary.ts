/** Deterministic comparison only. It never decides whether somebody deserves a promotion. */
export function compareRoleDescriptions(current: string, proposed: string) {
  const lines = (text: string) => [...new Set(text.replace(/\r/g, '').split(/\n+/).map(s => s.trim()).filter(Boolean))];
  const norm = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const before = lines(current), after = lines(proposed);
  if (current.length > 30000 || proposed.length > 30000) throw new Error('Job descriptions must be at most 30,000 characters each.');
  if (before.join(' ').length < 30 || after.join(' ').length < 30) throw new Error('Both job descriptions need at least 30 readable characters.');
  const a = new Set(before.map(norm)), b = new Set(after.map(norm));
  const removed = before.filter(s => !b.has(norm(s))), added = after.filter(s => !a.has(norm(s)));
  const unchanged = after.filter(s => a.has(norm(s)));
  const identical = norm(current) === norm(proposed) || !removed.length && !added.length;
  // Preserve the title/context and changed responsibility statements; no raw file is persisted.
  const excerpt = (context: string[], changed: string[]) => [...new Set([...context.slice(0, 2), ...changed.slice(0, 20)])].join('\n').slice(0, 8000);
  return { identical, added, removed, unchanged, currentSummary: excerpt(before, removed.length ? removed : before), proposedSummary: excerpt(after, added.length ? added : after) };
}
