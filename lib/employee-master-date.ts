import type { PersonnelFieldDescriptor } from './personnel-field-registry';
import type { MasterColumn } from './employee-master-report';

/** Presentation only. Keep ISO owner values, month precision and explicit Text unchanged. */
export function masterDateText(value: unknown, field: Pick<PersonnelFieldDescriptor, 'type'|'unit'>|undefined, format: MasterColumn['format'] = 'auto'): string|undefined {
 if (field?.type !== 'date' || typeof value !== 'string') return undefined;
 if (format === 'text' || field.unit === 'month') return value;
 if (field.unit === 'instant') {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} MYT`;
 }
 if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
 const date = new Date(value+'T00:00:00Z');
 if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) return value;
 const [year,month,day] = value.split('-'); return `${day}/${month}/${year}`;
}
