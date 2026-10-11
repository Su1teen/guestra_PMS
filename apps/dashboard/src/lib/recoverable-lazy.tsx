import { createElement, lazy, type ComponentType } from 'react';

const failedImports = new Set<() => void>();

/** React.lazy caches rejected imports. Reset only a failed import after an explicit retry. */
export function recoverableLazy(importer: () => Promise<{ default: ComponentType }>) {
  const load = () => importer().catch(error => { failedImports.add(reset); throw error; });
  let Page = lazy(load);
  const reset = () => { Page = lazy(load); failedImports.delete(reset); };
  return function RecoverablePage() { return createElement(Page); };
}

export function retryFailedPageImports() {
  for (const reset of failedImports) reset();
}
