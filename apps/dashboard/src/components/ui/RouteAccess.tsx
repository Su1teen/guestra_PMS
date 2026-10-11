import { Fragment, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { activeNavigationItem, NAVIGATION } from '../../lib/navigation';
import { QueryError } from './ErrorBoundary';

/** UI access follows the same catalog as navigation. The API remains authoritative. */
export default function RouteAccess({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const { hasPermission } = useAuth();
  const { propertyId } = useProperty();
  const to = activeNavigationItem(pathname, search);
  const item = NAVIGATION.flatMap(s => s.items).find(candidate => candidate.to === to);
  if (item && !hasPermission(item.permission)) return <QueryError error={{ response: { status: 403 } }} />;
  // A page's drafts and last mutation result belong to one property. Never display them in another.
  return <Fragment key={propertyId ?? 'unselected'}>{children}</Fragment>;
}
