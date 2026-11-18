import {z} from 'zod';
export const competencySectionsSchema=z.record(z.string().trim().min(1).max(200),z.string().trim().max(4000));
export function competencySectionsFor(raw:unknown,competencies:{principle:string}[]){
 const sections=competencySectionsSchema.parse(raw),assigned=new Set(competencies.map(c=>c.principle));
 if(Object.keys(sections).some(key=>!assigned.has(key)))throw Error('Use only assigned competency sections.');
 return sections;
}
export function readCompetencySections(form:FormData){return Object.fromEntries(form.getAll('sectionName').map((name,index)=>[String(name),String(form.get(`sectionRemark.${index}`)??'').trim()]));}
