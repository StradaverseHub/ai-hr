/** Reviewed Cloudflare-only ingress. CIDRs are installation inputs, never learned from request headers.
 * Snapshot verified 2026-11-02: https://www.cloudflare.com/ips-v4/ and /ips-v6/.
 * Nginx realip rewrites remote_addr: preserve origin ACLs using realip_remote_addr instead. */
import assert from 'node:assert/strict';
export const CLOUDFLARE_CIDRS=Object.freeze(['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32']);
/** Parameters allow a real socket fixture to use one loopback test edge; production uses the fixed list. */
export function renderIngressHttp({edgeNetworks=CLOUDFLARE_CIDRS,localPeer='127.0.0.1/32'}={}){
 assert(edgeNetworks.length>0&&edgeNetworks.every(n=>/^[0-9a-fA-F.:]+\/[0-9]{1,3}$/.test(n)));
 assert(/^[0-9a-fA-F.:]+\/[0-9]{1,3}$/.test(localPeer));
 return '# Managed OneHR ingress: verified edge identity; no credential or HR logging.\n'+
 edgeNetworks.map(n=>'set_real_ip_from '+n+';').join('\n')+'\nreal_ip_header CF-Connecting-IP;\nreal_ip_recursive off;\n'+
 'geo $realip_remote_addr $aihr_origin_peer_allowed {\n default 0;\n '+localPeer+' 1;\n '+edgeNetworks.map(n=>n+' 1;').join('\n ')+'\n}\n'+
 'geo $realip_remote_addr $aihr_cloudflare_peer {\n default 0;\n '+edgeNetworks.map(n=>n+' 1;').join('\n ')+'\n}\n'+
 // Missing/invalid CF headers must not silently put an entire edge behind one source budget.
 'map "$realip_remote_addr|$remote_addr" $aihr_source_unrestored {\n default 0;\n "~^(?<aihr_same_peer>[^|]+)[|](?P=aihr_same_peer)$" 1;\n}\n'+
 'map "$aihr_cloudflare_peer:$aihr_source_unrestored" $aihr_invalid_edge_source { default 0; "1:1" 1; }\n'+
 'map $http_cf_connecting_ip $aihr_multi_source { default 0; ~, 1; }\n'+
 // Worker subrequests have different client-IP semantics; no unknown Worker is implicitly trusted.
 'map $http_cf_worker $aihr_worker_source { default 1; "" 0; }\n'+
 'limit_req_zone $binary_remote_addr zone=aihr_auth_source:10m rate=2r/s;\n'+
 'limit_req_zone $binary_remote_addr zone=aihr_mobile_source:10m rate=10r/s;\n'+
 'limit_conn_zone $binary_remote_addr zone=aihr_source_connections:10m;\n';
}
export function hardenProxyConfig(text,{publicEdge=true}={}){
 assert(typeof text==='string'&&text.length<1048576&&!text.includes('aihr_origin_peer_allowed')&&!/\b(?:set_real_ip_from|real_ip_header|limit_req|limit_conn)\b/.test(text),'Unknown or already modified ingress profile');
 assert(!/proxy_set_header\s+x-aihr-request-source\b/i.test(text),'Unexpected existing source-header policy');
 if(publicEdge){
  const allows=[...text.matchAll(/^\s*allow ([^;]+);\s*$/gm)].map(m=>m[1]).sort();
  assert.deepEqual(allows,['127.0.0.1',...CLOUDFLARE_CIDRS].sort(),'Origin ACL differs from reviewed edge inventory');
  assert.equal([...text.matchAll(/^\s*deny all;\s*$/gm)].length,1,'Exact existing deny-all required');
  text=text.replace(/^[ \t]*allow [^;]+;[ \t]*\n/gm,'').replace(/^([ \t]*)deny all;[ \t]*$/m,'$1if ($aihr_origin_peer_allowed = 0) { return 403; }\n$1if ($aihr_invalid_edge_source = 1) { return 400; }\n$1if ($aihr_multi_source = 1) { return 400; }\n$1if ($aihr_worker_source = 1) { return 403; }\n$1client_header_timeout 10s;\n$1keepalive_timeout 15s;');
 }
 const blocks=[...text.matchAll(/^([ \t]*)location \/ \{\n([\s\S]*?)^\1\}/gm)];assert.equal(blocks.length,1,'One simple app root proxy required');
 const [whole,indent,original]=blocks[0];assert(!/[{}]/.test(original),'Nested or variable-brace proxy profile requires review');
 assert.equal([...original.matchAll(/proxy_pass http:\/\/127\.0\.0\.1:3000;/g)].length,1,'Exact loopback app upstream required');
 assert(!/location\s/.test(original)&&!text.includes('location ^~ /api/mobile/')&&!text.includes('location ^~ /login/api/'),'Ambiguous protected locations');
 const body=original+indent+'    proxy_set_header X-Aihr-Request-Source $remote_addr;\n';
 const extra=(path,zone,burst,connections,size,bodySeconds,readSeconds)=>{
  assert.equal([...body.matchAll(/proxy_read_timeout [^;]+;/g)].length,1,'One existing read deadline required');
  const bounded=body.replace(/proxy_read_timeout [^;]+;/,'proxy_read_timeout '+readSeconds+'s;');
  return indent+'location ^~ '+path+' {\n'+bounded+indent+'    limit_req zone='+zone+' burst='+burst+' nodelay;\n'+indent+'    limit_req_status 429;\n'+indent+'    error_page 429 = @aihr_ingress_limited;\n'+indent+'    limit_conn aihr_source_connections '+connections+';\n'+indent+'    limit_conn_status 429;\n'+indent+'    client_max_body_size '+size+';\n'+indent+'    client_body_timeout '+bodySeconds+'s;\n'+indent+'}\n';
 };
 const limited=indent+'location @aihr_ingress_limited {\n'+indent+'    default_type application/json;\n'+indent+'    add_header Cache-Control "no-store" always;\n'+indent+'    add_header X-Content-Type-Options "nosniff" always;\n'+indent+'    add_header Retry-After "1" always;\n'+indent+`    return 429 '{"error":"unavailable"}';\n`+indent+'}\n';
 return text.replace(whole,limited+extra('/login/api/','aihr_auth_source',30,20,'8k',10,30)+extra('/api/mobile/','aihr_mobile_source',60,20,'12m',30,45)+indent+'location / {\n'+body+indent+'}');
}
