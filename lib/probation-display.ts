import {onboardingTimestamp} from './onboarding-format';
/**
 * Probation display formats (lane L, L2). DISPLAY ONLY: stored values, comparisons and form inputs stay ISO.
 *
 * Instants print as the lifecycle audit format, "16/11/2026 12:11" in the HR timezone (lib/onboarding-format.ts →
 * lib/hr-date.ts). Postgres `timestamptz::text` ("2026-11-16 12:11:54.756+08") is normalised to ISO 8601 first, because
 * strict engines (Safari) refuse the space and the bare "+08" offset, and a client that cannot parse would render "—"
 * where the server rendered a time. Calendar days print as dd/mm/yyyy from the string itself (never through `new Date`,
 * which would shift a day west of UTC). Blank → "—"; anything unrecognised is returned unchanged rather than hidden.
 */
const INSTANT=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DAY=/^(\d{4})-(\d{2})-(\d{2})$/;
export const PROBATION_EMPTY='—';
/** An ISO 8601 instant every engine parses, or null when the value carries no explicit offset. */
export function probationIsoInstant(value:string):string|null{
 const m=INSTANT.exec(value.trim());if(!m)return null;
 const zone=m[3].toUpperCase()==='Z'?'Z':m[3].length===3?m[3]+':00':m[3].includes(':')?m[3]:m[3].slice(0,3)+':'+m[3].slice(3);
 return m[1]+'T'+m[2]+zone;
}
/** "16/11/2026 12:11" in the HR timezone for an instant (ISO or Postgres text). */
export function probationTimestamp(value:string|Date|null|undefined):string{
 if(value==null)return PROBATION_EMPTY;
 if(value instanceof Date)return onboardingTimestamp(value);
 const text=value.trim();if(!text)return PROBATION_EMPTY;
 const iso=probationIsoInstant(text);return iso?onboardingTimestamp(iso):text;
}
/** "02/12/2026" for a yyyy-mm-dd calendar day; an instant prints its HR-timezone day. */
export function probationDate(value:string|null|undefined):string{
 if(value==null)return PROBATION_EMPTY;
 const text=value.trim();if(!text)return PROBATION_EMPTY;
 const day=DAY.exec(text);if(day)return day[3]+'/'+day[2]+'/'+day[1];
 const iso=probationIsoInstant(text);return iso?onboardingTimestamp(iso).split(' ')[0]:text;
}
