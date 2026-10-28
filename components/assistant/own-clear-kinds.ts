export const OWN_CLEAR_KINDS=['proposals','ratings','feedback','conversation','importHistory','outcomes'] as const;
export type OwnClearKind=(typeof OWN_CLEAR_KINDS)[number];
