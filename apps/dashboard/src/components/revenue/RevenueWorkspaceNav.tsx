import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { propertyHref } from '../../lib/navigation';

const items = [
  ['/revenue', 'Обзор', 'Overview', 'revenue.manage'],
  ['/dynamic-pricing', 'Симуляция цен', 'Price simulation', 'revenue.manage'],
  ['/rate-plans', 'Тарифы и ограничения', 'Rates & restrictions', 'rateplans.read'],
  ['/reports?report=booking-pace', 'Прирост и темп продаж', 'Pickup & Pace', 'reports.view'],
  ['/reports?report=occupancy-trend', 'Динамика загрузки', 'Occupancy trend', 'reports.view'],
  ['/revenue?section=history', 'История изменений', 'Change history', 'revenue.manage'],
] as const;

export default function RevenueWorkspaceNav() {
  const { i18n } = useTranslation();
  const location = useLocation();
  const { propertyId } = useProperty();
  const { hasPermission } = useAuth();
  const ru = i18n.language.startsWith('ru');
  return (
    <nav aria-label={ru ? 'Revenue Management' : 'Revenue Management'} className="flex gap-2 overflow-x-auto mb-6 pb-1">
      {items.filter(item => hasPermission(item[3])).map(([to, ruLabel, enLabel]) => {
        const [path, query] = to.split('?');
        const params = new URLSearchParams(location.search);
        const active = location.pathname === path && (query ? [...new URLSearchParams(query)].every(([k,v]) => params.get(k) === v) : !params.has('section'));
        return (
          <NavLink
            key={to}
            to={propertyHref(to, propertyId)}
            aria-current={active ? 'page' : false}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold ${active ? 'bg-telivity-navy text-white' : 'border border-gray-200 bg-white text-telivity-slate hover:border-telivity-teal'}`}
          >
            {ru ? ruLabel : enLabel}
          </NavLink>
        );
      })}
    </nav>
  );
}
