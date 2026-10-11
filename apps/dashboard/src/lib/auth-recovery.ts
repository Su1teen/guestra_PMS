import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

declare module 'axios' {
  export interface InternalAxiosRequestConfig { authRecoveryAttempted?: boolean }
}

interface AuthRecovery {
  refresh: () => Promise<string | undefined>;
  login: () => Promise<unknown>;
}

/** One refresh for concurrent 401s, one safe read retry, one login if refresh cannot recover. */
export function installAuthRecovery(client: AxiosInstance, auth: AuthRecovery) {
  let refresh: Promise<string | undefined> | undefined;
  let loginStarted = false;
  const loginOnce = () => {
    if (loginStarted) return;
    loginStarted = true;
    void Promise.resolve().then(auth.login).catch(() => { /* No redirect/retry loop after failed login. */ });
  };
  const id = client.interceptors.response.use(response => response, async error => {
    if (axios.isCancel(error) || error.response?.status !== 401) return Promise.reject(error);
    const config = error.config as InternalAxiosRequestConfig | undefined;
    if (!config || config.authRecoveryAttempted || loginStarted) {
      loginOnce(); return Promise.reject(error);
    }
    config.authRecoveryAttempted = true;
    if (!refresh) refresh = Promise.resolve().then(auth.refresh).finally(() => { refresh = undefined; });
    let token: string | undefined;
    try { token = await refresh; } catch { loginOnce(); return Promise.reject(error); }
    if (!token) { loginOnce(); return Promise.reject(error); }
    if (config.signal?.aborted) return Promise.reject(new axios.CanceledError());
    // Refresh credentials, but leave business-write recovery to its existing domain workflow.
    if (!['get', 'head', 'options'].includes((config.method ?? 'get').toLowerCase())) return Promise.reject(error);
    config.headers.set('Authorization', `Bearer ${token}`);
    return client.request(config);
  });
  return () => client.interceptors.response.eject(id);
}
