/** General AI gateway (0661): the address rules, the internal-address check before every call, and that
 * only a gateway configuration may carry an address. DNS is stubbed; no network is used. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const dns=vi.hoisted(()=>({lookup:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:dns.lookup}));
import {readGatewayOptions,isInternalAddress,assertPublicGateway} from '../lib/ai/providers/gateway-options';
import {captureAiConfig} from '../lib/ai/governance';
beforeEach(()=>dns.lookup.mockReset());
describe('gateway address',()=>{
 it('accepts public https host names with an API path',()=>{
  for(const url of ['https://router.flatkey.ai/v1','https://api.example.com','https://gw.example.co.uk/openai/v1/'])expect(readGatewayOptions({version:1,baseUrl:url}).baseUrl).toBe(url);
 });
 it('refuses http, IP literals, local or single-label hosts, credentials, ports, queries and extra fields',()=>{
  for(const url of ['http://router.flatkey.ai/v1','https://10.0.0.5/v1','https://127.0.0.1','https://localhost/v1','https://gateway/v1','https://ai.corp/v1','https://box.internal','https://user:pw@example.com/v1','https://example.com:8443/v1','https://example.com/v1?x=1','https://example.com/v1#a','https://EXAMPLE.com/v1',' '])
   expect(()=>readGatewayOptions({version:1,baseUrl:url}),url).toThrow();
  expect(()=>readGatewayOptions({version:1,baseUrl:'https://router.flatkey.ai/v1',headers:{}})).toThrow();
  expect(()=>readGatewayOptions({version:2,baseUrl:'https://router.flatkey.ai/v1'})).toThrow();
 });
 it('classifies internal addresses, including IPv4-mapped IPv6',()=>{
  for(const ip of ['10.1.2.3','172.16.0.1','192.168.1.1','127.0.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:10.0.0.1'])expect(isInternalAddress(ip),ip).toBe(true);
  for(const ip of ['104.18.2.1','8.8.8.8','2606:4700::1111'])expect(isInternalAddress(ip),ip).toBe(false);
 });
 it('refuses a call when the host resolves to any internal address, or does not resolve',async()=>{
  dns.lookup.mockResolvedValueOnce([{address:'104.18.2.1'}]);await expect(assertPublicGateway('https://router.flatkey.ai/v1')).resolves.toBeUndefined();
  dns.lookup.mockResolvedValueOnce([{address:'104.18.2.1'},{address:'10.0.0.8'}]);await expect(assertPublicGateway('https://router.flatkey.ai/v1')).rejects.toThrow('not allowed');
  dns.lookup.mockRejectedValueOnce(Error('ENOTFOUND'));await expect(assertPublicGateway('https://router.flatkey.ai/v1')).rejects.toThrow('could not be reached');
  await expect(assertPublicGateway(undefined)).rejects.toThrow('missing');
 });
 it('lets only a gateway configuration carry an address, and re-validates it',()=>{
  expect(captureAiConfig({provider:'ai_gateway',model:'m',apiKey:'k',gatewayBaseUrl:'https://router.flatkey.ai/v1'}).gatewayBaseUrl).toBe('https://router.flatkey.ai/v1');
  expect(()=>captureAiConfig({provider:'openai',model:'m',apiKey:'k',gatewayBaseUrl:'https://router.flatkey.ai/v1'})).toThrow();
  expect(()=>captureAiConfig({provider:'ai_gateway',model:'m',apiKey:'k',gatewayBaseUrl:'https://10.0.0.1/v1'})).toThrow();
 });
});
