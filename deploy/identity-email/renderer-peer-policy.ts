/** Kernel-derived identity only. This module performs no environment lookup or activation. */
export type RendererPeerIdentity={rendererUid:number;selfUid:number;mailUid:number;peerUid:number;brokerUid?:number};
export function rendererPeerRole(value:RendererPeerIdentity):'mail'|'broker'|null {
  const ids=[value.rendererUid,value.selfUid,value.mailUid,value.peerUid,...(value.brokerUid===undefined?[]:[value.brokerUid])];
  if(ids.some(id=>!Number.isSafeInteger(id)||id<=0)||value.selfUid!==value.rendererUid||value.mailUid===value.rendererUid)return null;
  if(value.brokerUid!==undefined&&(value.brokerUid===value.rendererUid||value.brokerUid===value.mailUid))return null;
  if(value.peerUid===value.mailUid)return 'mail';
  return value.brokerUid!==undefined&&value.peerUid===value.brokerUid?'broker':null;
}
export function rendererPeerMayRequest(role:'mail'|'broker',phase:'status'|'render'|'authorize'|'remove'):boolean {
  return role==='mail'||phase==='authorize';
}
