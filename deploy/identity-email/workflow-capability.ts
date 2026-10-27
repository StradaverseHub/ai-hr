/** Installation capability only; mail readiness and category consent remain separate controls. */
export function attendanceCcUpgradeReady(status:number|undefined,value:unknown):boolean {
 if(status!==200||value===null||typeof value!=='object'||Array.isArray(value))return false;
 const result=value as Record<string,unknown>;
 return result.version===1&&result.attendanceCc===true;
}

/** Full current workflow agent capability. A configured relay or recipient consent is not required. */
export function letterWorkflowUpgradeReady(status:number|undefined,value:unknown):boolean {
 if(!attendanceCcUpgradeReady(status,value))return false;
 return (value as Record<string,unknown>).letters===true;
}
