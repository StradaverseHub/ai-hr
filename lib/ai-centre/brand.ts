/** The ONE place the AI's product name is configured. Owner choice, 2 November 2026: "Noveri", chosen but
 * NOT yet trademark-cleared, so it must stay a one-line change. Code identifiers, routes and files keep the
 * internal working name; only what people read comes from here. The name is never translated.
 * Set to null to fall back to the generic, translated "AI centre" (aiCentre.genericName). */
export const AI_PRODUCT_NAME: string | null = 'Noveri';

/** What people read for the product surface: always the generic, translated "AI Centre" (aiCentre.genericName). Owner,
 * 3 November 2026: "The menu should be called AI Centre instead of Noveri right? Noveri is just the AI Architecture
 * name, which should only appear in the clockwork page". AI_PRODUCT_NAME and AI_ARCHITECTURE_LABEL are therefore used
 * only by How it works (components/ai-centre/how-it-works.tsx and its view in app/assistant/page.tsx). */
export function aiCentreName(genericName: string): string {
  return genericName;
}

/** The architecture label shown only in How it works (heading line and the watch face): the name with
 * "OS", derived here so it is never typed separately. Null without a configured name. */
export const AI_ARCHITECTURE_LABEL: string | null = AI_PRODUCT_NAME ? `${AI_PRODUCT_NAME} OS` : null;
