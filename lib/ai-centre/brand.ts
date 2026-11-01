/** The ONE place the AI's product name is configured (ADR-0170 §9: the final name is undecided).
 * null shows the generic, translated "AI centre" (aiCentre.genericName). When a name is chosen it is set
 * here once and every screen passes it into its message as {name}; no copy hard-codes a product name. */
export const AI_PRODUCT_NAME: string | null = null;

export function aiCentreName(genericName: string): string {
  return AI_PRODUCT_NAME ?? genericName;
}
