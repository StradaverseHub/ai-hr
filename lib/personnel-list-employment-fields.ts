import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {PERSONNEL_EMPLOYMENT_FILTER_KEYS} from './personnel-list-controls';
/** Server metadata joins the native filter's closed fields to canonical Personnel labels/types. */
export const PERSONNEL_EMPLOYMENT_FILTERS=PERSONNEL_FIELDS.filter(f=>f.tab==='Employment'&&f.owner==='employment'&&f.grain==='single'&&f.report.enabled&&f.report.filter&&(PERSONNEL_EMPLOYMENT_FILTER_KEYS as readonly string[]).includes(f.ownerField)).map(f=>({key:f.ownerField,labelKey:f.labelKey,label:f.label,type:f.type}));
