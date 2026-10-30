/** Decode the actual controlled Nodemailer wire message; caller expectations never supply bytes. */
export function fixtureMailAttachments(raw: Buffer) {
  const result: { mime: string; filename: string; cid: string | null; bytes: Buffer }[] = [];
  function part(text: string) {
    const split = text.indexOf('\r\n\r\n'); if (split < 0) throw Error('Missing MIME headers');
    const headers = new Map<string,string>();
    for (const line of text.slice(0,split).replace(/\r\n[\t ]+/g,' ').split('\r\n')) { const colon=line.indexOf(':'); if(colon<1)throw Error('Invalid MIME header'); const key=line.slice(0,colon).toLowerCase();if(headers.has(key))throw Error('Repeated MIME header');headers.set(key,line.slice(colon+1).trim()); }
    const body=text.slice(split+4), type=headers.get('content-type')??'';
    if(type.toLowerCase().startsWith('multipart/')) {
      const boundary=type.match(/(?:^|;)\s*boundary="([^"\r\n]{1,200})"(?:;|$)/i)?.[1];if(!boundary)throw Error('Missing controlled MIME boundary');
      for(const child of body.split('--'+boundary).slice(1)){if(child.startsWith('--'))break;if(!child.startsWith('\r\n'))throw Error('Invalid MIME separator');part(child.slice(2));}
      return;
    }
    if(!/^(attachment|inline)(?:;|$)/i.test(headers.get('content-disposition')??''))return;
    if(headers.get('content-transfer-encoding')?.toLowerCase()!=='base64')throw Error('Unexpected attachment encoding');
    const encoded=body.trim();if(!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded))throw Error('Invalid attachment bytes');
    const filename=(headers.get('content-disposition')??'').match(/(?:^|;)\s*filename=(?:"([^"\r\n]+)"|([^;\r\n]+))/i);
    const cid=headers.get('content-id');result.push({mime:type.split(';')[0].trim().toLowerCase(),filename:filename?.[1]??filename?.[2]??'',cid:cid?cid.replace(/^<|>$/g,''):null,bytes:Buffer.from(encoded.replace(/\r\n/g,''),'base64')});
  }
  part(raw.toString('ascii')); return result;
}
