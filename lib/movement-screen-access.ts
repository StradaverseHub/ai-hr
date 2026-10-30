/** Creation and correction are different lifecycle decisions. An exit may itself be the mistake. */
export function movementScreenAccess(input: {admin: boolean; canMaintainWorkforce: boolean; terminatedOn: string | null}) {
  const canCorrectMovement = input.admin && input.canMaintainWorkforce;
  return {canCorrectMovement, canCreateMovement: canCorrectMovement && !input.terminatedOn};
}
