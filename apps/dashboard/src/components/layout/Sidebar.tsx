import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { useStoredPreference } from '../../hooks/useStoredPreference';
import { activeNavigationItem, propertyHref, visibleNavigation } from '../../lib/navigation';

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export default function Sidebar({ mobileOpen, onClose, collapsed, onToggleCollapsed }: SidebarProps) {
  const { hasPermission } = useAuth();
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const { propertyId, isPortfolioMode, properties } = useProperty();
  const [advancedOpen, setAdvancedOpen] = useStoredPreference('guestra.navigation.advanced');
  const sidebar = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const activeProperty = isPortfolioMode ? null : properties.find(p => p.id === propertyId);
  const brandName = isPortfolioMode ? 'Guestra' : (activeProperty?.staffDisplayName || activeProperty?.name || 'Guestra');
  const brandLogo = activeProperty?.staffLogoUrl;
  const tagline = isPortfolioMode ? t('header.allProperties') : t('nav.tagline');
  const sections = visibleNavigation(hasPermission);
  const active = activeNavigationItem(pathname, search, sections.flatMap(s => s.items));
  const advancedActive = sections.some(s => s.advanced && s.items.some(item => item.to === active));
  const showAdvanced = advancedOpen;
  useEffect(() => { if (advancedActive) setAdvancedOpen(true); }, [active, advancedActive, setAdvancedOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const targets = [...(sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])]
        .filter(element => element.getClientRects().length > 0);
      const first = targets[0], last = targets.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    const resize = () => { if (window.matchMedia('(min-width: 1024px)').matches) onClose(); };
    window.addEventListener('resize', resize);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); window.removeEventListener('resize', resize); previous?.focus(); };
  }, [mobileOpen, onClose]);

  return <>
    {mobileOpen && <button type="button" tabIndex={-1} aria-label={t('nav.closeMenu')}
      className="fixed inset-0 bg-black/40 z-40 lg:hidden" onClick={onClose} />}
    <aside ref={sidebar} id="main-sidebar" aria-label={t('nav.mainNavigation')}
      className={`guestra-sidebar ${collapsed ? 'sidebar-collapsed' : ''} bg-telivity-navy text-white flex flex-col h-screen fixed left-0 top-0 z-50 transition-[width,transform] duration-200 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      style={activeProperty?.staffPrimaryColor ? { backgroundColor: activeProperty.staffPrimaryColor } : undefined}>
      <div className="px-4 py-4 border-b border-white/10 flex items-center justify-between gap-2 min-h-20">
        <div className="sidebar-brand min-w-0 flex items-center gap-2">
          {brandLogo && <img src={brandLogo} alt="" className="h-8 w-8 rounded object-cover flex-shrink-0 bg-white/10" />}
          <div className="min-w-0"><h1 className="text-lg font-semibold tracking-wide truncate">{brandName}</h1>
            <p className="text-xs text-white/60 mt-0.5 truncate">{tagline}</p></div>
        </div>
        <button type="button" onClick={onToggleCollapsed} className="hidden lg:block p-2 rounded hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-telivity-teal"
          aria-label={t(collapsed ? 'navigation.expand' : 'navigation.collapse')} title={t(collapsed ? 'navigation.expand' : 'navigation.collapse')} aria-controls="main-sidebar" aria-expanded={!collapsed}>
          {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
        </button>
        <button ref={closeButton} type="button" onClick={onClose} className="lg:hidden p-1 rounded hover:bg-white/10" aria-label={t('nav.closeMenu')}><X size={18} /></button>
      </div>
      <nav className="flex-1 overflow-y-auto py-3" aria-label={t('nav.mainNavigation')}>
        {sections.map(section => <div key={section.labelKey}>
          {section.advanced ? <button type="button" onClick={() => setAdvancedOpen(!showAdvanced)}
            aria-expanded={showAdvanced} aria-controls="advanced-navigation" title={t(section.labelKey)}
            className={`sidebar-link flex items-center gap-3 w-full px-4 py-3 text-xs font-semibold text-white/70 hover:bg-white/5 ${advancedActive ? 'text-telivity-teal' : ''}`}>
            <Settings2 size={18} className="shrink-0" aria-hidden="true" />
            <span className="sidebar-label flex-1 text-left">{t(section.labelKey)}</span>
            <span className="sidebar-label">{showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          </button> : <p className="sidebar-section px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{t(section.labelKey)}</p>}
          {(!section.advanced || showAdvanced) && <div id={section.advanced ? 'advanced-navigation' : undefined}>
            {section.items.map(({ to, icon: Icon, labelKey }) => <NavLink key={to} to={propertyHref(to, propertyId)}
              onClick={onClose} title={t(labelKey)} aria-label={t(labelKey)} aria-current={active === to ? 'page' : false}
              className={`sidebar-link flex items-center gap-3 px-4 py-2.5 text-sm font-medium border-r-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-telivity-teal ${active === to ? 'bg-telivity-teal/15 text-telivity-teal border-telivity-teal' : 'text-white/70 hover:text-white hover:bg-white/5 border-transparent'}`}>
              <Icon size={18} className="shrink-0" aria-hidden="true" /><span className="sidebar-label truncate">{t(labelKey)}</span>
            </NavLink>)}
          </div>}
        </div>)}
      </nav>
      <div className="sidebar-footer px-4 py-3 border-t border-white/10 text-xs text-white/50">Guestra PMS</div>
    </aside>
  </>;
}
