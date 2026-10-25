/** Explicit disposable targets; a fresh release review never adopts older fixture identities. */
export function board1LocalAcceptanceTarget() {
  const target = process.env.BOARD1_ACCEPTANCE_TARGET ?? 'remaining4';
  if (target === 'remaining4') return {
    directory: '/private/tmp/aihr-board1-remaining4-20261021',
    homeDatabase: 'ai_hr_board1_home_acceptance',
    payrollDatabase: 'ai_hr_board1_acceptance',
  };
  if (target === 'release20261023') return {
    directory: '/private/tmp/aihr-board1-release-20261023',
    homeDatabase: 'ai_hr_board1_release_20261023',
    payrollDatabase: 'ai_hr_board1_release_20261023',
  };
  throw Error('Choose an explicit allowed Board 1 local acceptance target.');
}
