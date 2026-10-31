import {expect,it} from 'vitest';
import {resolvePersonalEaSelection} from '../app/(app)/me/ea/selection-state';
const sources=[
 {year:'2024',employmentId:'old-employment',companyId:'old-employer',isCurrent:false},
 {year:'2025',employmentId:'own-employment',companyId:'old-employer',isCurrent:false},
 {year:'2025',employmentId:'own-employment',companyId:'current-employer',isCurrent:true},
];
it('defaults to the newest own source year and a current employer form independently of input order',()=>{
 expect(resolvePersonalEaSelection(sources,{})).toEqual(sources[2]);
 expect(resolvePersonalEaSelection([...sources].reverse(),{})).toEqual(sources[2]);
});
it('preserves an exact historical own employment, paying employer and year',()=>{
 expect(resolvePersonalEaSelection(sources,{year:'2024',employmentId:'old-employment',company:'old-employer'})).toEqual(sources[0]);
 expect(resolvePersonalEaSelection(sources,{year:'2025',company:'old-employer'})).toEqual(sources[1]);
});
it.each([{year:'2023'},{year:'garbled'},{year:''},{year:'2025-03'},{company:''},{employmentId:''},{company:'foreign-employer'},{employmentId:'foreign-employment'},{year:'2024',company:'current-employer'}])('refuses a stale or malformed EA selection %j without another-form fallback',request=>{
 expect(resolvePersonalEaSelection(sources,request)).toBeUndefined();
});
it('has no selection when there is no eligible source metadata',()=>{
 expect(resolvePersonalEaSelection([],{})).toBeUndefined();
});
