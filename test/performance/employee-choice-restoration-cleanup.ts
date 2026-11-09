/** Mandatory fixture cleanup sequencing only; no SQL, pool or native authority. */
export function employeeChoiceRestorationCleanup(onTelemetryFailure:()=>void,onWorkFailure:(name:string)=>void){
 const failures:unknown[]=[];
 const retain=(error:unknown)=>{if(!failures.some(value=>Object.is(value,error)))failures.push(error);};
 const telemetry=(write:()=>void)=>{try{write();}catch(error){retain(error);try{onTelemetryFailure();}catch(fault){retain(fault);}}};
 return{failures,telemetry,
  async run(name:string,work:()=>Promise<unknown>,observe:(status:'started'|'completed')=>void){
   telemetry(()=>observe('started'));
   try{await work();telemetry(()=>observe('completed'));return true;}
   catch(error){retain(error);try{onWorkFailure(name);}catch(fault){retain(fault);}return false;}
  },
 };
}
