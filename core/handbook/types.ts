/** AI v2 Phase 2, P2-5 — the Living Handbook's closed vocabulary (pure: no database, safe for a client or a DOM test).
 * The settings a policy can enforce and their owners are described in ./settings.ts, which re-exports all of this. */
export const POLICY_AREAS=['leave','attendance','claims','allowances','people','other'] as const;
export type PolicyArea=(typeof POLICY_AREAS)[number];
export const isPolicyArea=(value:unknown):value is PolicyArea=>typeof value==='string'&&(POLICY_AREAS as readonly string[]).includes(value);
export const POLICY_SETTINGS=['claims.mileage_rates','claims.submit_within_days','leave.entitlement_days'] as const;
export type PolicySetting=(typeof POLICY_SETTINGS)[number];
export const isPolicySetting=(value:unknown):value is PolicySetting=>typeof value==='string'&&(POLICY_SETTINGS as readonly string[]).includes(value);
/** Which settings a policy of an area may enforce. Every other area is text only. */
export const AREA_SETTINGS:Readonly<Record<PolicyArea,readonly PolicySetting[]>>=Object.freeze({
 claims:['claims.mileage_rates','claims.submit_within_days'],leave:['leave.entitlement_days'],attendance:[],allowances:[],people:[],other:[],
});
/** Undated owner settings take effect when written, so a future-dated value waits for its date. */
export const UNDATED_SETTINGS:ReadonlySet<PolicySetting>=new Set(['claims.submit_within_days']);
export const SETTING_OWNER:Readonly<Record<PolicySetting,'claims'|'leave'>>=Object.freeze({'claims.mileage_rates':'claims','claims.submit_within_days':'claims','leave.entitlement_days':'leave'});

export type MileageBandValue=Readonly<{fromKm:number;toKm:number|null;ratePerKm:number}>;
export type EntitlementBandValue=Readonly<{fromYears:number;toYears:number|null;days:number}>;
export type SettingBody=Readonly<{bands:readonly MileageBandValue[]}>|Readonly<{days:number}>|Readonly<{bands:readonly EntitlementBandValue[]}>;
export type SettingTarget=Readonly<{claimType?:string;leaveType?:string}>;
