import { useState, useEffect, useLayoutEffect, useCallback, type ReactNode, useMemo } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { useMyPermissions } from '../../hooks/useAdmin';
import { useStoredPreference } from '../../hooks/useStoredPreference';
import { QueryError } from '../ui/ErrorBoundary';
import { SkeletonPage } from '../ui/Skeleton';
import './navigation.css';

export default function AppLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useStoredPreference('guestra.navigation.collapsed');
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const { authEnabled, setPermissions } = useAuth();
  const { propertyId, isPortfolioMode, properties } = useProperty();

  const permissionsPropertyId =
    isPortfolioMode ? (properties[0]?.id ?? null) : propertyId;

  const permissionQuery = useMyPermissions(permissionsPropertyId, authEnabled);
  const { data } = permissionQuery;
  useLayoutEffect(() => {
    // Clear the previous property's UI grants before paint while the new scope loads.
    setPermissions(data?.permissions ?? []);
  }, [permissionsPropertyId, data, setPermissions]);

  const activeProperty = useMemo(
    () => (isPortfolioMode ? null : properties.find((p) => p.id === propertyId) ?? null),
    [isPortfolioMode, properties, propertyId],
  );

  useEffect(() => {
    const root = document.documentElement;
    if (activeProperty?.staffPrimaryColor) {
      root.style.setProperty('--staff-primary', activeProperty.staffPrimaryColor);
    } else {
      root.style.removeProperty('--staff-primary');
    }
    if (activeProperty?.staffAccentColor) {
      root.style.setProperty('--staff-accent', activeProperty.staffAccentColor);
    } else {
      root.style.removeProperty('--staff-accent');
    }
  }, [activeProperty?.staffPrimaryColor, activeProperty?.staffAccentColor]);

  return (
    <div className={`min-h-screen bg-telivity-light-grey ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-white focus:p-3">Перейти к содержимому</a>
      <Sidebar mobileOpen={sidebarOpen} onClose={closeSidebar} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <div className="guestra-content" aria-hidden={sidebarOpen || undefined} ref={element => { if (element) element.inert = sidebarOpen; }}>
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <main id="main-content" className="p-3 sm:p-4 lg:p-6" tabIndex={-1}>
          {authEnabled && permissionQuery.isError ? <QueryError error={permissionQuery.error} onRetry={() => void permissionQuery.refetch()} /> :
            authEnabled && (!permissionsPropertyId || permissionQuery.isPending) ? <SkeletonPage /> : children}
        </main>
      </div>
    </div>
  );
}
