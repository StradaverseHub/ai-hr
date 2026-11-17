/** Intentional drift guard for a private native admission mirror of the ONE existing date owner. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import proof from './fixtures/contract-posting-date-owner-source.json';
const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
it('requires review if the actual native date-selection/calendar/timezone owner changes',()=>{
 const source=read('../core/movement.ts'),clock=read('../lib/hr-date.ts');
 const switchStart=source.indexOf('    switch (e.eventType) {');
 const line=(text:string,start:string)=>text.slice(text.indexOf(start),text.indexOf('\n',text.indexOf(start)));
 const fragments={
  groupEvidenceAndFallback:source.slice(source.indexOf('  const groupDates = '),source.indexOf('  let sawHiredEvent = ')),
  primaryDateSelection:source.slice(switchStart,source.indexOf("      case 'employment.blacklisted':")),
  datedReportingAndRecorded:source.slice(source.indexOf("      case 'reporting-line.set':",switchStart),source.indexOf("      case 'employment.movement.applied':",switchStart)),
  clockReference:line(source,'const dateOf = '),clockConstant:line(clock,'export const HR_LOCAL_TZ = '),clockFormatter:line(clock,'const localDateFormatter='),
  clockFunction:clock.slice(clock.indexOf('export function todayInKualaLumpur('),clock.indexOf('\n}',clock.indexOf('export function todayInKualaLumpur('))+2),
  calendarValidation:read('../lib/calendar-date.ts'),
 };
 for(const[name,value]of Object.entries(fragments)){expect(value.length,name).toBeGreaterThan(20);expect(digest(value),name).toBe(proof.sha256[name as keyof typeof proof.sha256]);}
});
