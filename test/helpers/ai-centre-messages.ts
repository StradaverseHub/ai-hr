/** The AI centre catalogue is a separate file merged in i18n/request.ts (messages/<locale>.json sits inside
 * the approved provider-data digest). Tests that render with a catalogue merge it the same way. */
import en from '../../messages/en.json';
import aiCentreEn from '../../messages/ai-centre/en.json';

type Dict = Record<string, unknown>;
export function mergeMessages<A extends Dict, B extends Dict>(base: A, over: B): A & B {
  const out: Dict = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
      ? mergeMessages(current as Dict, value as Dict) : value;
  }
  return out as A & B;
}
export const enWithAiCentre = mergeMessages(en, aiCentreEn);
import aiCentreMs from '../../messages/ai-centre/ms.json';
import aiCentreZh from '../../messages/ai-centre/zh.json';
import aiCentreVi from '../../messages/ai-centre/vi.json';
import aiCentreTa from '../../messages/ai-centre/ta.json';
import aiCentreTh from '../../messages/ai-centre/th.json';
const AI_CENTRE: Record<string, Dict> = { en: aiCentreEn, ms: aiCentreMs, zh: aiCentreZh, vi: aiCentreVi, ta: aiCentreTa, th: aiCentreTh };
/** A locale's catalogue with the AI centre's merged over it, as i18n/request.ts does. */
export function withAiCentre<A extends Dict>(locale: string, base: A): A {
  return mergeMessages(base, AI_CENTRE[locale] ?? aiCentreEn) as A;
}
