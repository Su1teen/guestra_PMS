import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { installAuthRecovery } from './auth-recovery';

function rejected(config: InternalAxiosRequestConfig, status = 401): never {
  throw new AxiosError('private response', 'ERR_BAD_RESPONSE', config, undefined, { data: {}, status, statusText:'Error', headers:{}, config });
}
const response = (config: InternalAxiosRequestConfig) => ({data:{ok:true},status:200,statusText:'OK',headers:{},config});
describe('bounded authentication recovery', () => {
  it('shares one refresh across concurrent failures and retries with the fresh token', async () => {
    const adapter = vi.fn<AxiosAdapter>(async config => config.headers.get('Authorization') === 'Bearer fresh' ? response(config) : rejected(config));
    const client = axios.create({adapter});
    const refresh = vi.fn(async () => 'fresh'), login = vi.fn(async () => {});
    installAuthRecovery(client,{refresh,login});
    const results = await Promise.all([client.get('/one'),client.get('/two'),client.get('/three')]);
    expect(results.every(r=>r.status===200)).toBe(true);
    expect(refresh).toHaveBeenCalledOnce(); expect(login).not.toHaveBeenCalled(); expect(adapter).toHaveBeenCalledTimes(6);
  });
  it('redirects once if concurrent refresh failures cannot recover', async () => {
    const client = axios.create({adapter: async config => rejected(config)});
    const refresh=vi.fn(async()=>{throw Error('refresh failed');}), login=vi.fn(async()=>{});
    installAuthRecovery(client,{refresh,login});
    const results=await Promise.allSettled([client.get('/one'),client.get('/two')]);
    expect(results.every(r=>r.status==='rejected')).toBe(true);
    await Promise.resolve(); expect(refresh).toHaveBeenCalledOnce(); expect(login).toHaveBeenCalledOnce();
    await expect(client.get('/third')).rejects.toBeDefined(); expect(login).toHaveBeenCalledOnce();
  });
  it('never loops on a second 401', async () => {
    const adapter=vi.fn<AxiosAdapter>(async config=>rejected(config));
    const client=axios.create({adapter}); const refresh=vi.fn(async()=> 'fresh'),login=vi.fn(async()=>{});
    installAuthRecovery(client,{refresh,login});
    await expect(client.get('/one')).rejects.toBeDefined();
    expect(adapter).toHaveBeenCalledTimes(2);expect(refresh).toHaveBeenCalledOnce();expect(login).toHaveBeenCalledOnce();
  });
  it('does not refresh a forbidden request and removes its interceptor on cleanup', async () => {
    const client=axios.create({adapter: async config=>rejected(config,403)});
    const refresh=vi.fn(async()=> 'fresh'),login=vi.fn(async()=>{});
    const cleanup=installAuthRecovery(client,{refresh,login});
    await expect(client.get('/forbidden')).rejects.toBeDefined(); expect(refresh).not.toHaveBeenCalled();expect(login).not.toHaveBeenCalled();
    cleanup();client.defaults.adapter=async config=>rejected(config);
    await expect(client.get('/unauthorized')).rejects.toBeDefined();expect(refresh).not.toHaveBeenCalled();
  });
  it('does not resend a request cancelled during the refresh', async () => {
    const controller=new AbortController();
    const adapter=vi.fn<AxiosAdapter>(async config=>rejected(config));
    const client=axios.create({adapter});const login=vi.fn(async()=>{});
    installAuthRecovery(client,{refresh:async()=>{controller.abort();return 'fresh';},login});
    await expect(client.get('/cancel',{signal:controller.signal})).rejects.toMatchObject({code:'ERR_CANCELED'});
    expect(adapter).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled();
  });
  it('refreshes credentials without replaying a financial or other business write',async()=>{
    const adapter=vi.fn<AxiosAdapter>(async config=>rejected(config));const client=axios.create({adapter});
    const refresh=vi.fn(async()=> 'fresh'), login=vi.fn(async()=>{});
    installAuthRecovery(client,{refresh,login});
    await expect(client.post('/charges',{amount:'100.00'})).rejects.toBeDefined();
    expect(adapter).toHaveBeenCalledOnce();expect(refresh).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled();
  });
});
