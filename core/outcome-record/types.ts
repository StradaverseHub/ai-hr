/** ADR-0170 §3.11 and §11.3 change 5 — the outcome record's value shapes. A leaf: no imports, so db/schema.ts
 * can type its JSON columns from here without a cycle.
 *
 * Every field is a name, a version, a count, a verdict or an internal id used as a record reference. None is
 * HR data, question text or reply text: the data stays in its native owners. */
export type OutcomeKind='answered'|'suggested'|'prepared'|'done'|'fallback'|'refused'|'stopped';
/** §11.3 change 5: how far a person was involved in the outcome. */
export type HumanInvolvement='none'|'reviewed'|'decided';
/** §11.3 change 5: whether the person the outcome is about was told. 'not_applicable' when that person is the
 * one who asked. */
export type NoticeState='not_applicable'|'given'|'not_given';
/** What was read: the tool or owner function, how it ended, and references to the records it returned. */
export type OutcomeRead=Readonly<{tool:string;status:string;argumentsDigest?:string;refs?:readonly string[]}>;
/** One native check as it ran, with the rule version the owner returned (null: the owner publishes none). */
export type OutcomeCheck=Readonly<{check:string;owner:string;ruleVersion:string|null;result:'pass'|'needs_review'|'fail'}>;
/** Replay: what produced the result, so it can be explained later. */
export type OutcomeReplay=Readonly<{model:string|null;provider:string|null;instructionSet:string|null;specVersion:string|null;specDigest:string|null;toolCatalogue:string|null}>;
