import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { realmDefinition } from '../deploy/keycloak/realm';

describe('deployment-owned identity bootstrap boundaries',()=>{
  it('uses a pinned release digest and a private production service, without performing the app cutover',()=>{
    const install=readFileSync('deploy/keycloak/install.sh','utf8');
    expect(install).toContain('VERSION=26.8.0');expect(install).toContain('sha256sum --check --status');
    expect(install).toContain('KC_HTTP_HOST=127.0.0.1');expect(install).toContain('KC_HTTP_MANAGEMENT_HOST=127.0.0.1');
    expect(install).toContain('KC_PROXY_TRUSTED_ADDRESSES=127.0.0.1/32,::1/128');
    // Keycloak persists this at build time; setting it only for optimized startup refuses to boot.
    expect(install).toMatch(/kc\.sh build[^\n]*--http-relative-path=\/identity/);
    const service=readFileSync('deploy/keycloak/aihr-keycloak.service','utf8');
    expect(service).toContain('User=aihr-keycloak');expect(service).toContain('start --optimized');expect(service).toContain('NoNewPrivileges=true');
    expect(service).not.toContain('start-dev');expect(install).not.toContain('systemctl restart aihr\n');
  });
  it('keeps identity administration/master endpoints private and excludes token-bearing URLs from access logs',()=>{
    const edge=readFileSync('deploy/keycloak/edge.conf.template','utf8');
    expect(edge).toContain('listen 127.0.0.1:3001');
    for(const route of ['/identity/admin','/identity/realms/master']) {
      expect(edge).toContain(`location = ${route} { return 404; }`);
      expect(edge).toContain(`location ${route}/ { return 404; }`);
    }
    const log=edge.match(/^log_format aihr_identity_safe (.+);$/m);
    expect(log).not.toBeNull();expect(log![1]).not.toMatch(/\$request_uri|\$uri|\$args|\$request[^_m]/);
  });
  it('requires an explicit existing account for audited owner enrollment and never writes HR grants',()=>{
    const source=readFileSync('scripts/keycloak-link-owner.ts','utf8');
    expect(source).toContain('--app-user-id=');expect(source).toContain('app-user.identity-linked');
    expect(source).toContain('No grants or HR records were changed');
    expect(source).not.toMatch(/insert into (?:role_assignment|person|employment)/i);
  });
  it('matches logout destinations exactly and does not permit arbitrary redirect origins',()=>{
    const realm=realmDefinition('https://hr.test');
    const web=realm.clients.find(c=>c.clientId==='aihr-web')!;
    expect(web.redirectUris).toEqual(['https://hr.test/callback','https://hr.test/invite/*']);
    expect(web.attributes?.['post.logout.redirect.uris']).toBe('https://hr.test/login?signedOut=1');
    expect(()=>realmDefinition('http://hr.test')).toThrow();expect(()=>realmDefinition('https://hr.test/')).toThrow();
  });
});
