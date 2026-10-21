import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { CredentialAdminGuard } from './credential-admin.guard';
import { ConnectScopeGuard } from './connect-scope.guard';
const context = (request: any) => ({ switchToHttp: () => ({getRequest: () => request}) }) as any;
describe('staff and machine authentication separation', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('keeps production Connect protected with staff auth disabled, even if a bypass is requested', async () => {
    vi.stubEnv('NODE_ENV','production');
    const config = new ConfigService({NODE_ENV:'production',AUTH_ENABLED:'false',CONNECT_AUTH_REQUIRED:'false'});
    await expect(new ApiKeyGuard(config).canActivate(context({headers:{},path:'/api/v1/connect/properties'}))).rejects.toThrow('API key');
  });
  it('v2 cannot inherit a non-production staff bypass', async () => {
    await expect(new ApiKeyGuard(new ConfigService({AUTH_ENABLED:'false'})).canActivate(context({headers:{},path:'/api/v1/connect/v2/capabilities'}))).rejects.toThrow('API key');
  });
  it('never exposes credential administration through staff demo mode', () => {
    expect(() => new CredentialAdminGuard(new ConfigService({AUTH_ENABLED:'false'})).canActivate(context({user:{id:'synthetic'}}))).toThrow('STAFF_AUTH_REQUIRED');
    expect(() => new CredentialAdminGuard(new ConfigService({AUTH_ENABLED:'true'})).canActivate(context({}))).toThrow('STAFF_AUTH_REQUIRED');
  });
  it('scoped read credentials cannot reach a legacy write to avoid v2 validation', async () => {
    vi.stubEnv('NODE_ENV','production');
    const config = new ConfigService({NODE_ENV:'production',AUTH_ENABLED:'false'});
    const request = {path:'/api/v1/connect/book',method:'POST',connect:{scope:'property',propertyId:'one',scopes:['pms:scoped:v1','integration.read']}};
    await expect(new ConnectScopeGuard(config,{}).canActivate(context(request))).rejects.toThrow('SCOPED_CREDENTIAL_REQUIRES_V2');
  });
});
