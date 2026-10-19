/** Identifier-first remains the default for existing import paths. Full hire organisation fields
 * explicitly opt into label-first; ambiguity always refuses within the chosen precedence tier. */
export class PersonnelImportLookup<T> {
  private exact = new Map<string, Map<string,T>>();
  private names = new Map<string, Map<string,T>>();
  private key(value:string) { return value.trim().toLowerCase(); }
  add(id:string,value:T,options:{codes?:readonly (string|null|undefined)[];names?:readonly (string|null|undefined)[]}={}) {
    for(const [store,keys] of [[this.exact,[id,...options.codes??[]]],[this.names,options.names??[]]] as const) {
      for(const raw of keys) {if(!raw?.trim())continue;const key=this.key(raw),matches=store.get(key)??new Map<string,T>();matches.set(id,value);store.set(key,matches);}
    }
    return this;
  }
  constructor(private readonly policy:'identifier-first'|'label-first'='identifier-first') {}
  private matches(value:string) {const key=this.key(value);return this.policy==='label-first' ? this.names.get(key)??this.exact.get(key) : this.exact.get(key)??this.names.get(key);}
  get(value:string):T|undefined {const matches=this.matches(value);return matches?.size===1?[...matches.values()][0]:undefined;}
  isAmbiguous(value:string) {return (this.matches(value)?.size??0)>1;}
}
/** Repeated aliases for one identity are harmless; aliases spanning identities must refuse. */
export function addUniqueImportAlias(map:Map<string,string|null>,key:string,id:string) {
  if(!map.has(key))map.set(key,id);else if(map.get(key)!==id)map.set(key,null);
}
