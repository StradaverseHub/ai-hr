
/** 9070acae — a review is always exactly one company and one business unit, whatever the top company selector
 *  shows; the title, the scope line and every save button on the review name it. */
export const rewardReviewTitle = (cycle: string, company: string, unit: string) => `${cycle} · ${company ? `${company} / ` : ''}${unit}`;
/** 37f82412 — the Review tab header: Company · Business Unit · cycle (for example 2026 Annual Compensation Review). */
export const rewardReviewHeaderTitle = (company: string, unit: string, cycle: string) => [company, unit, cycle].filter(Boolean).join(' · ');
export function UnitScopeNote({ text }: { text: string }) { return <p className="text-sm text-muted-foreground">{text}</p>; }
