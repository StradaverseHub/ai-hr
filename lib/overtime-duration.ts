/** Display only. Stored and submitted overtime remains integer minutes. */
export function formatMinutesToHM(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error('Overtime duration must be nonnegative integer minutes');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? `${rest}m` : ''}` : `${rest}m`;
}

/** Plans belong to their start date. Equal times are invalid; an earlier end is next day. */
export function plannedOvertimeMinutes(start: string, end: string): number | null {
  const parse = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
  const a = parse(start), b = parse(end);
  if (a == null || b == null || a === b) return null;
  return (b - a + 1440) % 1440;
}
