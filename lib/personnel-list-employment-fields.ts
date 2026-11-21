import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {PERSONNEL_EMPLOYMENT_FILTER_KEYS} from './personnel-list-controls';
/** Server metadata joins the native filter's closed fields to canonical Personnel labels/types. */
export const PERSONNEL_EMPLOYMENT_FILTERS=PERSONNEL_FIELDS.filter(f=>f.tab==='Employment'&&['employment','directSuperior'].includes(f.owner)&&f.grain==='single'&&f.report.enabled&&f.report.filter&&(PERSONNEL_EMPLOYMENT_FILTER_KEYS as readonly string[]).includes(f.owner==='directSuperior'?'directSuperior'+f.ownerField[0].toUpperCase()+f.ownerField.slice(1):f.ownerField)).map(f=>({key:f.owner==='directSuperior'?'directSuperior'+f.ownerField[0].toUpperCase()+f.ownerField.slice(1):f.ownerField,labelKey:f.labelKey,label:f.label,type:f.type}));
