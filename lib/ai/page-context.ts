/** What the floating Assistant may know about the page a person has open: a closed AREA and, at most, one
 * record id taken from the address. Never screen text, form values or other people's details — those
 * would be leakage and an injection channel. The Assistant still reads the record only through the
 * person's own permissions, so naming an id grants nothing. Pure: shared by the client launcher (to
 * label the chip and hide the button) and the server action (which re-derives it; posted labels are
 * never trusted). */
export const PAGE_AREAS = ['home','me','leave','attendance','claims','payroll','performance','approvals','lifecycle','letters','knowledge','org','people','rewards','analytics','controlTower','settings'] as const;
export type PageArea = (typeof PAGE_AREAS)[number];
export type PageContext = { area: PageArea; recordId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOP: Readonly<Record<string, PageArea>> = {
  me: 'me', leave: 'leave', attendance: 'attendance', claims: 'claims', payroll: 'payroll', performance: 'performance',
  approvals: 'approvals', lifecycle: 'lifecycle', letters: 'letters', 'knowledge-base': 'knowledge', org: 'org',
  personnel: 'people', manage: 'people', rewards: 'rewards', analytics: 'analytics', 'control-tower': 'controlTower',
};
/** Administration pages that belong to a module area; every other admin page is "settings". */
const ADMIN: Readonly<Record<string, PageArea>> = {
  personnel: 'people', leave: 'leave', 'leave-config': 'leave', 'leave-approval': 'leave', toil: 'leave', claims: 'claims',
  attendance: 'attendance', 'attendance-policy': 'attendance', 'attendance-allowance': 'attendance', 'work-locations': 'attendance',
  'pay-components': 'payroll', 'payroll-config': 'payroll', 'payroll-cycle': 'payroll', 'payroll-policy': 'payroll',
  'payroll-permissions': 'payroll', loans: 'payroll', rewards: 'rewards', lifecycle: 'lifecycle', organization: 'org',
};

/** null: the Assistant itself, an unknown area, or anything that is not a plain in-app path. */
export function resolvePageContext(path: unknown): PageContext | null {
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || path.startsWith('//') || /[\s\\?#]/.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'assistant') return null;
  const area: PageArea | undefined = segments.length === 0 ? 'home'
    : segments[0] === 'admin' ? (segments[1] ? ADMIN[segments[1]] ?? 'settings' : 'settings')
    : TOP[segments[0]];
  if (!area) return null;
  const recordId = segments.find(segment => UUID.test(segment))?.toLowerCase() ?? null;
  return { area, recordId };
}
export const isPageArea = (value: unknown): value is PageArea => typeof value === 'string' && (PAGE_AREAS as readonly string[]).includes(value);
