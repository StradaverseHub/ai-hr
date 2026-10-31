export type PersonalEaRequest={year?:string;employmentId?:string;company?:string};
type EaChoice={year:string;employmentId:string;companyId:string;isCurrent:boolean};

/** An explicit unavailable selection never silently opens another year or employer's form. */
export function resolvePersonalEaSelection<T extends EaChoice>(sources:readonly T[],request:PersonalEaRequest):T|undefined {
 if(request.year!==undefined&&!/^\d{4}$/.test(request.year))return undefined;
 if(request.employmentId===''||request.company==='')return undefined;
 const year=request.year??sources.reduce<string|undefined>((latest,row)=>latest===undefined||row.year>latest?row.year:latest,undefined);
 const matching=sources.filter(row=>row.year===year);
 if(request.employmentId!==undefined||request.company!==undefined)return matching.find(row=>
  (request.employmentId===undefined||row.employmentId===request.employmentId)
  &&(request.company===undefined||row.companyId===request.company));
 return matching.find(row=>row.isCurrent)??matching[0];
}
