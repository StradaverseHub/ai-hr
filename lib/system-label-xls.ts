/** Bounded CFB/BIFF admission for legacy XLS. No macros, formulas or protection are executed.
 * Sector chains are checked before parsing; allocation is bounded by the admitted file's bytes.
 * Supports normal v3/v4 CFB with header DIFAT (a 5 MB XLS needs no extended DIFAT).
 */
export function legacyLabelWorkbookStream(bytes:Buffer):Buffer {
  const invalid=()=>new Error('Invalid or unsupported legacy XLS workbook.');
  if(bytes.length<512||bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw invalid();
  const major=bytes.readUInt16LE(26),shift=bytes.readUInt16LE(30);
  if(bytes.readUInt16LE(28)!==0xfffe||!((major===3&&shift===9)||(major===4&&shift===12))||bytes.readUInt16LE(32)!==6||bytes.readUInt32LE(56)!==4096)throw invalid();
  const sectorSize=2**shift,sectorCount=bytes.length/sectorSize-1;
  if(!Number.isInteger(sectorCount)||sectorCount<1||bytes.readUInt32LE(72)!==0||![0xfffffffe,0xffffffff].includes(bytes.readUInt32LE(68)))throw invalid();
  const fatCount=bytes.readUInt32LE(44),fatIds:number[]=[];
  if(!fatCount||fatCount>109||fatCount>sectorCount||fatCount*sectorSize/4<sectorCount)throw invalid();
  const sector=(id:number)=>{if(!Number.isInteger(id)||id<0||id>=sectorCount)throw invalid();return bytes.subarray((id+1)*sectorSize,(id+2)*sectorSize);};
  for(let n=0;n<fatCount;n++){const id=bytes.readUInt32LE(76+n*4);sector(id);if(fatIds.includes(id))throw invalid();fatIds.push(id);}
  const fat=fatIds.map(sector),next=(id:number)=>fat[Math.floor(id/(sectorSize/4))].readInt32LE(id%(sectorSize/4)*4);
  // Reject invalid pointers and cycles, including unused chains, before any chain concatenation.
  const state=new Uint8Array(sectorCount);
  for(let start=0;start<sectorCount;start++){
    if(state[start])continue;
    const path:number[]=[];let id=start;
    while(id>=0){if(id>=sectorCount||state[id]===1)throw invalid();if(state[id]===2)break;state[id]=1;path.push(id);id=next(id);if(id<0&&![-1,-2,-3,-4].includes(id))throw invalid();}
    for(const visited of path)state[visited]=2;
  }
  const chain=(start:number)=>{
    const ids:number[]=[];let id=start;
    while(id>=0){if(id>=sectorCount||ids.length>=sectorCount)throw invalid();ids.push(id);id=next(id);}
    if(id!==-2)throw invalid();return Buffer.concat(ids.map(sector));
  };
  const directory=chain(bytes.readInt32LE(48));
  if(!directory.length||directory.length>160*128)throw new Error('Too many legacy XLS directory entries.');
  type Entry={name:string;type:number;start:number;size:number};
  const entries:Entry[]=[];
  for(let offset=0;offset<directory.length;offset+=128){
    const type=directory[offset+66];if(!type)continue;
    const nameLength=directory.readUInt16LE(offset+64),size=directory.readBigUInt64LE(offset+120);
    if(![1,2,5].includes(type)||nameLength<2||nameLength>64||nameLength%2||size>BigInt(bytes.length))throw invalid();
    entries.push({name:directory.subarray(offset,offset+nameLength-2).toString('utf16le'),type,start:directory.readInt32LE(offset+116),size:Number(size)});
  }
  if(entries.some(entry=>/^(EncryptionInfo|EncryptedPackage)$/i.test(entry.name)))throw new Error('Protected or encrypted Excel workbooks cannot be imported.');
  const roots=entries.filter(entry=>entry.type===5),books=entries.filter(entry=>entry.type===2&&/^(Workbook|Book)$/i.test(entry.name));
  if(roots.length!==1||books.length!==1)throw invalid();
  const book=books[0];let stream:Buffer;
  if(book.size>=4096)stream=chain(book.start).subarray(0,book.size);
  else{
    const root=roots[0],miniCount=bytes.readUInt32LE(64);
    if(!miniCount||miniCount>sectorCount)throw invalid();
    const miniFat=chain(bytes.readInt32LE(60));
    if(miniFat.length!==miniCount*sectorSize)throw invalid();
    const miniStream=chain(root.start).subarray(0,root.size),chunks:Buffer[]=[],seen=new Set<number>();
    let id=book.start;
    while(id>=0){
      if(seen.has(id)||id*64+64>miniStream.length||id*4+4>miniFat.length||chunks.length*64>=book.size+64)throw invalid();
      seen.add(id);chunks.push(miniStream.subarray(id*64,id*64+64));id=miniFat.readInt32LE(id*4);
    }
    if(id!==-2)throw invalid();stream=Buffer.concat(chunks).subarray(0,book.size);
  }
  if(stream.length!==book.size||stream.length<8||stream.readUInt16LE(0)!==0x0809)throw invalid();
  for(let offset=0;offset<stream.length;){
    if(offset+4>stream.length)throw invalid();
    const record=stream.readUInt16LE(offset),length=stream.readUInt16LE(offset+2);offset+=4;
    if(length>8224||offset+length>stream.length)throw invalid();
    if(record===0x002f||([0x0012,0x0019,0x0063,0x00dd].includes(record)&&length>=2&&stream.readUInt16LE(offset)!==0))throw new Error('Protected or encrypted Excel workbooks cannot be imported.');
    if([0x0006,0x0206,0x0406,0x0221,0x04bc].includes(record))throw new Error('Formula in legacy XLS workbook. Enter literal values.');
    offset+=length;
  }
  return stream;
}
