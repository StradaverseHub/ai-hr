/** Native Offboarding case classifications; distinct from Personnel termination narrative and type. */
export const V9_EXIT_TYPES=['Resignation','Termination','Contract end','Retirement','Non-confirmation'] as const;
export type ExitType=(typeof V9_EXIT_TYPES)[number];
export const isV9ExitType=(value:unknown):value is ExitType=>typeof value==='string'&&(V9_EXIT_TYPES as readonly string[]).includes(value);
