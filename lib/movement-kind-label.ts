/**
 * e6a144d4 — the Employment History event-type caption, lifted OUT of the Personnel detail page so the
 * Download Excel route (app/admin/personnel/[employmentId]/movement-export/route.ts) prints the same word
 * the screen prints. It was a closure inside page.tsx; two copies of a twenty-case switch is exactly how a
 * file and the screen it claims to reproduce start disagreeing about what an event is called.
 *
 * Unchanged from the page version in every respect that matters:
 *
 *   • `configuredLabel` (476f23ed — the tenant's own name for this type, from their Movement Settings
 *     catalogue) WINS over the shipped translation. Null/empty means they never renamed it.
 *   • The shipped kinds resolve through a STATIC key map, never a dynamic `t()` template, so a missing
 *     translation is caught by the i18n scan instead of rendering a raw key at runtime.
 *   • Anything else — an unknown or future kind recorded via `employment.movement.recorded` — is
 *     humanized ("someKind" → "Some Kind"), so no surface can ever print a bare key.
 *
 * `t` is a `people.detail` namespace translator (the page's own `t`), which is why every key below is
 * spelled `movement.eventType.*`. Pure and translator-injected, so it unit-tests with no fixtures.
 */
export type MovementKindTranslator = (key: string, values?: Record<string, string | number>) => string;

export function movementKindLabel(
  kind: string,
  configuredLabel: string | null | undefined,
  t: MovementKindTranslator,
): string {
  if (configuredLabel) return configuredLabel;
  switch (kind) {
    case 'hired': return t('movement.eventType.hired');
    case 'transfer': return t('movement.eventType.transfer');
    // b7b22514 — without this case the humanized fallback below would label the row "Entity Transfer" in
    // English and leave it in English in the other five locales. A shipped kind belongs in the map.
    case 'entityTransfer': return t('movement.eventType.entityTransfer');
    case 'promotion': return t('movement.eventType.promotion');
    case 'demotion': return t('movement.eventType.demotion');
    case 'increment': return t('movement.eventType.increment');
    case 'salaryAdjustment': return t('movement.eventType.salaryAdjustment');
    case 'confirmation': return t('movement.eventType.confirmation');
    case 'probationExtension': return t('movement.eventType.probationExtension');
    case 'secondment': return t('movement.eventType.secondment');
    case 'actingPosition': return t('movement.eventType.actingPosition');
    case 'resignation': return t('movement.eventType.resignation');
    case 'termination': return t('movement.eventType.termination');
    case 'blacklist': return t('movement.eventType.blacklist');
    case 'blacklistCleared': return t('movement.eventType.blacklistCleared');
    case 'orgAssignmentChange': return t('movement.eventType.orgAssignmentChange');
    case 'reportingLineChange': return t('movement.eventType.reportingLineChange');
    case 'employmentTypeChange': return t('movement.eventType.employmentTypeChange');
    case 'gradeChange': return t('movement.eventType.gradeChange');
    // 89ea527b — the two employment-date movements.
    case 'joinDateChange': return t('movement.eventType.joinDateChange');
    case 'groupJoinDateCorrection': return t('movement.eventType.groupJoinDateCorrection');
    default: return kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  }
}
