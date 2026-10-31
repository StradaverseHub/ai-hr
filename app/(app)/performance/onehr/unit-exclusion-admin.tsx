import { getSession } from '@/lib/session';
import { getUnitExclusionScreen } from '@/packs/performance/service';
import { Card } from '@/components/ui';
import { UnitExclusionCard } from './unit-exclusion-card';

/** D-P1-22 X5 (ADR-0150): the cycle page's "Units not taking part" card. The service decides who may read and write. */
export async function UnitExclusionAdmin({ cycleId }: { cycleId: string }) {
  const screen = await getUnitExclusionScreen(await getSession(), cycleId);
  return <Card className="p-5"><UnitExclusionCard screen={screen} /></Card>;
}
