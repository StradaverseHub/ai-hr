/**
 * d1e26f81 — Return and revoke presets. One rule for the pending preview, submission and the release back-fill:
 * the team comes from the item's Fulfilling team in Onboarding & Offboarding settings (a retired entry keeps its
 * last team), else the team recorded on the issuing onboarding item, else nobody; issued asset-register devices
 * use the Group Tech fulfilment group. Physical items are due Day -1 and system access Day 0 from the effective
 * last working day. An access card with "Facility prints, Group Tech activates" returns as two rows: Facility
 * collects the card (Day -1), then Group Tech deactivates it (Day 0).
 */
import { defaultReturnDay, returnDue, type Case, type Config, type Item, type ReturnMethod, type ReturnPreset } from './lifecycle-v9-model';

export type ReturnCatalogueEntry = { id: string; name: string; kind: 'system' | 'device'; group: string; active: boolean; card: boolean; companies: string[] };
export type ReturnHolding = { caseId: string; requestId: string; requestNumber: string; itemId: string; catalogueId: string; name: string; kind: 'system' | 'device'; group: string; claim: string | null; handedAt: string | null; card: boolean };
export type ReturnAsset = { id: string; code: string; model?: string | null; assetType: string };
export type ReturnSources = { techGroup: string; assets: ReturnAsset[]; holdings: ReturnHolding[]; catalogue: ReturnCatalogueEntry[]; selections: string[] };
/** One planned row: the stored item fields plus the pending preview id its presets are keyed by. */
export type ReturnRow = Omit<Item, 'id' | 'assignee' | 'status' | 'reason' | 'dueOn'> & { previewId: string; method: ReturnMethod; dueDay: number | null; pairKey?: string };

/** Catalogue entries offered to the leaver's company (no Company rule, or one that names it). */
export function offeredToCompany(entry: Pick<ReturnCatalogueEntry, 'companies'>, companyId: string): boolean {
    return !entry.companies.length || entry.companies.includes(companyId);
}
/** A group id only while that group still exists in settings. */
export const existingGroup = (config: Pick<Config, 'groups'>, id: string | null | undefined): string | null => id && config.groups.some(group => group.id === id) ? id : null;
const existing = existingGroup;

export function returnRows(c: Pick<Case, 'returnPresets'>, config: Pick<Config, 'groups'>, sources: ReturnSources): ReturnRow[] {
    const preset = (id: string): ReturnPreset => c.returnPresets?.[id] ?? {};
    const rows: ReturnRow[] = [];
    const push = (row: Omit<ReturnRow, 'method' | 'dueDay'> & { dueDay?: number }) => {
        const chosen = preset(row.previewId);
        rows.push({ ...row, group: chosen.group !== undefined ? existing(config, chosen.group) : row.group, method: chosen.method ?? 'rr', dueDay: chosen.due ?? row.dueDay ?? defaultReturnDay(row.kind) });
    };
    for (const asset of sources.assets)
        push({ previewId: 'asset:' + asset.id, name: `${asset.code} · ${asset.model ?? asset.assetType}`, kind: 'device', sourceId: asset.id, catalogueId: null, group: existing(config, sources.techGroup), providedBy: null });
    for (const holding of sources.holdings) {
        const entry = sources.catalogue.find(item => item.id === holding.catalogueId);
        const team = existing(config, entry?.group) ?? existing(config, holding.group);
        const base = { previewId: 'onboarding:' + holding.itemId, catalogueId: holding.catalogueId, providedBy: { group: holding.group || null, userId: holding.claim, at: holding.handedAt } };
        const nativeSource = { caseId: holding.caseId, requestId: holding.requestId, requestNumber: holding.requestNumber, itemId: holding.itemId };
        if (entry?.card ?? holding.card) {
            const pairKey = 'card:' + holding.itemId;
            push({ ...base, name: holding.name, kind: 'device', sourceId: null, nativeSource, group: team, cardStep: 'collect', pairKey, dueDay: -1 });
            push({ ...base, name: holding.name, kind: 'system', sourceId: null, group: existing(config, sources.techGroup), cardStep: 'deactivate', pairKey, dueDay: 0 });
        } else push({ ...base, name: holding.name, kind: holding.kind, sourceId: null, nativeSource, group: team });
    }
    for (const id of sources.selections) {
        const entry = sources.catalogue.find(item => item.id === id);
        if (!entry || sources.holdings.some(holding => holding.catalogueId === id)) continue;
        push({ previewId: id, name: entry.name, kind: entry.kind, sourceId: null, sourceCatalogueId: id, catalogueId: id, group: existing(config, entry.group), providedBy: null });
    }
    return rows;
}

/** The planned due date: a Day offset from the anchor, or the case's fixed revoke date for system access. */
export function plannedDue(c: Pick<Case, 'revokeMode' | 'revokeDate'>, row: Pick<ReturnRow, 'kind' | 'dueDay' | 'previewId' | 'cardStep'>, anchor: string, presets: Case['returnPresets']): { dueOn: string; dueDay: number | null } {
    if (row.kind === 'system' && c.revokeMode === 'date' && presets?.[row.previewId]?.due === undefined) return { dueOn: c.revokeDate, dueDay: null };
    const day = row.dueDay ?? 0;
    return { dueOn: returnDue(anchor, day), dueDay: day };
}
