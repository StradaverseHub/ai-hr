/**
 * Localization registry (ADR-0008). The active country pack is selected by `company.country`.
 * The generic core never references a specific jurisdiction — it asks the registry.
 */
import { myPack } from './my';

type CountryPack = typeof myPack;

const PACKS: Record<string, CountryPack> = {
  MY: myPack,
};

export function packFor(country: string | null | undefined): CountryPack | undefined {
  return country ? PACKS[country.toUpperCase()] : undefined;
}
