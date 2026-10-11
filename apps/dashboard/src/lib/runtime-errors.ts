export function isChunkLoadError(error: unknown): boolean {
  const value = error as { name?: string; message?: string } | null;
  return value?.name === 'ChunkLoadError' || /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed|Unable to preload CSS/i.test(value?.message ?? '');
}

/** Do not log messages, stack, URLs, request bodies or identifiers from runtime/API errors. */
export function logRuntimeFailure(kind: 'render' | 'request' | 'promise' | 'chunk', error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  console.error('[Guestra runtime]', { kind: isChunkLoadError(error) ? 'chunk' : kind,
    ...(Number.isInteger(status) && status! >= 400 && status! <= 599 ? { status } : {}) });
}

export function installRuntimeDiagnostics() {
  const listener = (event: PromiseRejectionEvent) => logRuntimeFailure('promise', event.reason);
  window.addEventListener('unhandledrejection', listener);
  return () => window.removeEventListener('unhandledrejection', listener);
}
