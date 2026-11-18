/** Pure display rule for the Security Center Users list (board 07c98c36). */
/** Employee ID for the Users list: the code(s) of the person's current employment(s), newest hire first;
 * when every employment has ended, the most recent one's code. Display only; null when none has a code. */
export function currentEmployeeCode(
  employments: { employeeCode: string | null; hiredOn: string; terminatedOn: string | null; lastWorkingDate: string | null }[],
  today: string,
): string | null {
  const coded = employments.filter((e) => e.employeeCode?.trim()).sort((a, b) => b.hiredOn.localeCompare(a.hiredOn));
  const current = coded.filter((e) => e.hiredOn <= today && !(e.terminatedOn && e.terminatedOn < today) && !(e.lastWorkingDate && e.lastWorkingDate < today));
  const chosen = current.length ? current : coded.slice(0, 1);
  return chosen.length ? [...new Set(chosen.map((e) => e.employeeCode!.trim()))].join(', ') : null;
}
