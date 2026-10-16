import {z} from 'zod';
/** Selection conveys no authority. Each server use resolves the current live own-subject set. */
export const ownEmploymentSelection=z.string().uuid();
export class OwnEmploymentSelectionError extends Error {
 constructor(){super('Select an available own employment.');this.name='OwnEmploymentSelectionError';}
}
export function selectOwnEmployment<T extends {employmentId:string}>(subjects:readonly T[],selected?:string):T {
 if(selected!==undefined&&!ownEmploymentSelection.safeParse(selected).success)throw new OwnEmploymentSelectionError();
 const result=selected?subjects.find(subject=>subject.employmentId===selected):subjects.length===1?subjects[0]:undefined;
 if(!result)throw new OwnEmploymentSelectionError();
 return result;
}
