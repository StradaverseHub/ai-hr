import type {PersonnelPrivateCriteria} from '@/lib/personnel-list-controls';
/** Full criteria travel only in same-origin POST bodies and protected HTML, never in a URL. */
export function PrivateCriteriaFields({criteria,exclude=[]}:{criteria:PersonnelPrivateCriteria;exclude?:readonly string[]}){
 return <>{!exclude.includes('term')&&<input type="hidden" name="term" value={criteria.term}/>} {criteria.filters.filter(filter=>!exclude.includes(filter.field)).map(filter=><span key={filter.field}><input type="hidden" name={'field.'+filter.field} value={filter.value}/><input type="hidden" name={'operator.'+filter.field} value={filter.operator}/></span>)}</>;
}
