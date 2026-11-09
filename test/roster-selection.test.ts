import {expect,it} from 'vitest';
import {parseRosterSelection,ROSTER_SELECTION_MAX_BYTES} from '../lib/roster-selection';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
it('retains the entire explicit set beyond any display page',()=>{const ids=Array.from({length:50000},(_,i)=>id(i));expect(parseRosterSelection(JSON.stringify(ids))).toEqual(ids);});
it.each([null,'[]','["bad-id"]',JSON.stringify([id(1),id(1)]),'{}','[',new File(['bad'],'selection.json')])('refuses missing, empty, forged, duplicate or malformed prepared input',value=>{expect(()=>parseRosterSelection(value)).toThrow();});
it('refuses excess payload instead of silently truncating',()=>{expect(()=>parseRosterSelection(' '.repeat(ROSTER_SELECTION_MAX_BYTES+1))).toThrow('too large');});
