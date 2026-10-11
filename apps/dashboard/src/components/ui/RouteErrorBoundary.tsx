import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useProperty } from '../../context/PropertyContext';
import { retryFailedPageImports } from '../../lib/recoverable-lazy';
import { ErrorBoundary } from './ErrorBoundary';

export default function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { propertyId } = useProperty();
  return <ErrorBoundary resetKey={`${location.key}:${propertyId ?? ''}`} onRetry={retryFailedPageImports}>
    {children}
  </ErrorBoundary>;
}
