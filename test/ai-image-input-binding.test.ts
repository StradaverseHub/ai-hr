/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

/** Authored UNRUN. Gateway input custody only; synthetic signature bytes, mocked adapter, no API. */
import {expect,it,vi} from 'vitest';
import {readImage} from '../lib/ai';
import {captureImageInput,imageInputDigest} from '../lib/ai/image-input';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import type {AiGovernance} from '../lib/ai/governance';
const png=()=>new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
it('clones the retained caller buffer before asynchronous admission and binds the actual normalized input',async()=>{const original=png(),expected=imageInputDigest(captureImageInput({data:original,mimeType:'image/png'})),seen:number[][]=[];const governance:AiGovernance={async run(request,call){expect(request.operation).toBe('image');expect(request.inputDigest).toBe(expected);original[11]=99;return call(()=>{});}};const adapter=vi.spyOn(anthropicAdapter,'readImage').mockImplementation(async(_cfg,args)=>{seen.push([...args.data]);return 'Synthetic text';});try{await expect(readImage({provider:'anthropic',model:'fictional-model',apiKey:'fictional-key',governance},{data:original,mimeType:'image/png'})).resolves.toBe('Synthetic text');expect(adapter).toHaveBeenCalledTimes(1);expect(seen[0][11]).toBe(0);expect(original[11]).toBe(99);}finally{adapter.mockRestore();}});
it('refuses mismatched image content before the adapter without retrying',async()=>{const bytes=png(),other=png();other[11]=1;const allowed=imageInputDigest(captureImageInput({data:bytes,mimeType:'image/png'}));const governance:AiGovernance={async run(request,call){if(request.inputDigest!==allowed)throw Error('Synthetic source input refused');return call(()=>{});}},adapter=vi.spyOn(anthropicAdapter,'readImage');try{await expect(readImage({provider:'anthropic',model:'fictional-model',apiKey:'fictional-key',governance},{data:other,mimeType:'image/png'})).rejects.toThrow('Synthetic source input refused');expect(adapter).not.toHaveBeenCalled();}finally{adapter.mockRestore();}});
it('normalizes only the original native timeout bounds and retains MIME/content distinctions',()=>{const bytes=png(),base=captureImageInput({data:bytes,mimeType:'image/png'});expect(base.timeoutMs).toBe(20000);expect(imageInputDigest(base)).toBe(imageInputDigest(captureImageInput({data:bytes,mimeType:'image/png',timeoutMs:50000})));expect(imageInputDigest(base)).not.toBe(imageInputDigest(captureImageInput({data:bytes,mimeType:'image/png',timeoutMs:10})));expect(()=>captureImageInput({data:bytes,mimeType:'image/jpeg'})).toThrow();});
