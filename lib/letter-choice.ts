import type {LetterField} from './letter-model';
export type LetterChoice={id:string;label:string;field?:{definition:LetterField;ordinal:number}};
export type LetterChoices={rows:LetterChoice[];nextCursor:string|null};
export type LetterChoiceKind='field'|'letterhead'|'signatory';
