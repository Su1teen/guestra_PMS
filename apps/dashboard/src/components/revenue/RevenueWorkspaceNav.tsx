import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const items = [
  ['/revenue', 'Обзор', 'Overview'],
  ['/dynamic-pricing', 'Календарь цен', 'Price calendar'],
  ['/rate-plans', 'Правила', 'Rules'],
  ['/reports?report=booking-pace', 'Pickup & Pace', 'Pickup & Pace'],
  ['/reports?report=occupancy-trend', 'Прогноз', 'Forecast'],
  ['/revenue?section=history', 'История изменений', 'Change history'],
] as const;

export default function RevenueWorkspaceNav() {
  const { i18n } = useTranslation();
  const location = useLocation();
  const ru = i18n.language.startsWith('ru');
  return (
    <nav aria-label={ru ? 'Revenue Management' : 'Revenue Management'} className="flex gap-2 overflow-x-auto mb-6 pb-1">
      {items.map(([to, ruLabel, enLabel]) => {
        const [path, query] = to.split('?');
        const active = location.pathname === path && (!query || location.search.includes(query));
        return (
          <NavLink
            key={to}
            to={to}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold ${active ? 'bg-telivity-navy text-white' : 'border border-gray-200 bg-white text-telivity-slate hover:border-telivity-teal'}`}
          >
            {ru ? ruLabel : enLabel}
          </NavLink>
        );
      })}
    </nav>
  );
}
