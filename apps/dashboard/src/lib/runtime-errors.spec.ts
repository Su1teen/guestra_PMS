import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { installRuntimeDiagnostics, isChunkLoadError, logRuntimeFailure } from './runtime-errors';
import { shouldRetryQuery } from './queryClient';

afterEach(() => vi.restoreAllMocks());
describe('runtime recovery policy', () => {
  it('recognizes import errors without treating API or arbitrary render failures as version changes', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/page-hash.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError({ response: { status: 500 } })).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
  it('logs only a bounded category/status without personal data, messages or request URLs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRuntimeFailure('request', { message: 'guest passport private', response: { status: 403 }, config: { url: '/guest/private' } });
    expect(spy).toHaveBeenCalledWith('[Guestra runtime]', { kind: 'request', status: 403 });
  });
  it('limits transient retries and never repeats cancelled or 4xx requests', () => {
    for (const status of [400,401,403,404,409,422,429]) expect(shouldRetryQuery(0,{response:{status}})).toBe(false);
    expect(shouldRetryQuery(0, new axios.CanceledError())).toBe(false);
    expect(shouldRetryQuery(0, {response:{status:500}})).toBe(true);
    expect(shouldRetryQuery(1, {response:{status:500}})).toBe(false);
    expect(shouldRetryQuery(0, new Error('offline'))).toBe(true);
  });
  it('cleans up the promise diagnostic listener without swallowing the failure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanup = installRuntimeDiagnostics();
    const event = new Event('unhandledrejection', { cancelable:true });
    Object.assign(event,{reason:new Error('Private context')});
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    cleanup(); window.dispatchEvent(event); expect(spy).toHaveBeenCalledOnce();
  });
});
