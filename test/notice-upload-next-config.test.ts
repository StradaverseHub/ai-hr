import {describe,expect,it} from 'vitest';
import {PHASE_DEVELOPMENT_SERVER} from 'next/constants';
import {defaultConfig} from 'next/dist/server/config-shared';
import configuration from '../next.config';
import {PROFILE_ATTACHMENT_ACTION_BODY_LIMIT} from '../lib/profile-attachment';
import {NOTICE_ATTACHMENT_MAX_BYTES,NOTICE_UPLOAD_MULTIPART_OVERHEAD_BYTES} from '../lib/notice-upload-policy';
describe('Notice multipart and Next body-clone contract',()=>{
 it('buffers the complete permitted multipart body and an excess-byte witness before the route reader',()=>{
  const resolved=configuration(PHASE_DEVELOPMENT_SERVER),budget=resolved.experimental?.proxyClientMaxBodySize??defaultConfig.experimental.proxyClientMaxBodySize;
  expect(typeof budget).toBe('number');
  expect(budget as number).toBeGreaterThan(NOTICE_ATTACHMENT_MAX_BYTES+NOTICE_UPLOAD_MULTIPART_OVERHEAD_BYTES);
  expect(budget as number).toBeLessThanOrEqual(Math.max(NOTICE_ATTACHMENT_MAX_BYTES+2*NOTICE_UPLOAD_MULTIPART_OVERHEAD_BYTES,PROFILE_ATTACHMENT_ACTION_BODY_LIMIT+1));
 });
});
