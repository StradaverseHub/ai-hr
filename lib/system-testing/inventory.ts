import type { ReviewedCatalogue } from './model';
/** Inputs come from canonical SCREENS and MODULE_CATALOG; a guide is not a claim of complete coverage. */
export function testingCoverageInventory(catalogue: ReviewedCatalogue, screens: readonly { screenKey: string; href: string; labelKey: string; routes: readonly string[] }[], modules: readonly { code: string; name: string; packBacked: boolean }[]) {
  const known = new Set(screens.map(s => s.screenKey));
  const invalid = catalogue.entries.flatMap(e => e.definition.screenKeys.filter(key => !known.has(key)).map(screenKey => ({ semanticId: e.semanticId, screenKey })));
  if (invalid.length) throw new Error('Reviewed guide references an unknown canonical screen.');
  return {
    screens: screens.map(s => {
      const guideIds = catalogue.entries.filter(e => e.definition.active && e.definition.screenKeys.includes(s.screenKey)).map(e => e.semanticId).sort();
      return { ...s, guideIds, coverage: guideIds.length ? 'reviewed_guides_present' as const : 'guide_gap' as const };
    }),
    modules: modules.map(m => ({ ...m, guideIds: catalogue.entries.filter(e => e.definition.active && e.definition.moduleCode === m.code).map(e => e.semanticId).sort() })),
    /** No automatic "all implemented functions tested" or manual pass inference. */
    manualExecutionVerified: false as const,
  };
}
