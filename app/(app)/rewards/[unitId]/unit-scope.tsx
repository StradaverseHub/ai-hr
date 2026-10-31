
/** 9070acae — a review is always exactly one company and one business unit, whatever the top company selector
 *  shows; the title, the scope line and every save button on the review name it. */
export const rewardReviewTitle = (cycle: string, company: string, unit: string) => `${cycle} · ${company ? `${company} / ` : ''}${unit}`;
export function UnitScopeNote({ text }: { text: string }) { return <p className="text-sm text-muted-foreground">{text}</p>; }
