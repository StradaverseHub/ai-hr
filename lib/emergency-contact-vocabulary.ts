/** Canonical priorities shared by the owner, Personnel forms and import. */
export const EMERGENCY_CONTACT_PRIORITIES=['primary','secondary','other'] as const;
export type EmergencyContactPriority=(typeof EMERGENCY_CONTACT_PRIORITIES)[number];
