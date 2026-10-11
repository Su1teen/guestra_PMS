import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, ConciergeBell, ClipboardList, CalendarDays, Users, DoorOpen,
  Sparkles, ClipboardCheck, Receipt, TrendingUp, Gauge, BadgeDollarSign,
  BarChart3, Moon, UsersRound, Briefcase, Banknote, Building2, Calculator,
  ReceiptText, Radio, Plug, Mail, MessageSquare, ShieldCheck, Upload, Settings,
} from 'lucide-react';
import { isBookingRequestsUiEnabled } from './bookingRequestsFeature';

export interface NavigationItem {
  to: string;
  icon: LucideIcon;
  labelKey: string;
  permission: string;
}
export interface NavigationSection { labelKey: string; advanced?: boolean; items: NavigationItem[] }

export const NAVIGATION: NavigationSection[] = [
  { labelKey: 'navigation.main', items: [
    { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard', permission: 'dashboard.view' },
    { to: '/front-desk', icon: ConciergeBell, labelKey: 'nav.frontDesk', permission: 'frontdesk.access' },
    { to: '/booking-requests', icon: ClipboardList, labelKey: 'nav.bookingRequests', permission: 'reservations.read' },
    { to: '/reservations', icon: CalendarDays, labelKey: 'nav.reservations', permission: 'reservations.read' },
    { to: '/guests', icon: Users, labelKey: 'nav.guests', permission: 'guests.read' },
    { to: '/rooms', icon: DoorOpen, labelKey: 'nav.rooms', permission: 'rooms.read' },
    { to: '/services', icon: CalendarDays, labelKey: 'nav.services', permission: 'services.read' },
    { to: '/groups', icon: UsersRound, labelKey: 'nav.groups', permission: 'groups.read' },
    { to: '/commercial', icon: Briefcase, labelKey: 'nav.commercial', permission: 'commercial.read' },
  ] },
  { labelKey: 'navigation.operations', items: [
    { to: '/housekeeping', icon: Sparkles, labelKey: 'nav.housekeeping', permission: 'housekeeping.read' },
    { to: '/operations', icon: ClipboardCheck, labelKey: 'nav.operations', permission: 'ops.read' },
    { to: '/housekeeping?tab=shifts', icon: CalendarDays, labelKey: 'navigation.staff', permission: 'housekeeping.read' },
    { to: '/night-audit', icon: Moon, labelKey: 'nav.nightAudit', permission: 'nightaudit.run' },
  ] },
  { labelKey: 'navigation.revenue', items: [
    { to: '/revenue', icon: TrendingUp, labelKey: 'nav.revenueManagement', permission: 'revenue.manage' },
    { to: '/dynamic-pricing', icon: Gauge, labelKey: 'nav.dynamicPricing', permission: 'revenue.manage' },
    { to: '/rate-plans', icon: BadgeDollarSign, labelKey: 'nav.ratePlans', permission: 'rateplans.read' },
  ] },
  { labelKey: 'navigation.finance', items: [
    { to: '/reports/management', icon: TrendingUp, labelKey: 'nav.managementReport', permission: 'reports.view' },
    { to: '/reports?report=daily-revenue', icon: BarChart3, labelKey: 'navigation.drr', permission: 'reports.view' },
    { to: '/folios', icon: Receipt, labelKey: 'nav.foliosBilling', permission: 'folios.read' },
    { to: '/reports', icon: BarChart3, labelKey: 'navigation.financialReports', permission: 'reports.view' },
    { to: '/cashier', icon: Banknote, labelKey: 'nav.cashier', permission: 'cashier.access' },
    { to: '/house-accounts', icon: Building2, labelKey: 'nav.houseAccounts', permission: 'houseaccounts.read' },
    { to: '/accounting', icon: Calculator, labelKey: 'nav.accounting', permission: 'accounting.view' },
  ] },
  { labelKey: 'navigation.advanced', advanced: true, items: [
    { to: '/revenue?section=agents', icon: Gauge, labelKey: 'navigation.agentTools', permission: 'revenue.manage' },
    { to: '/tax', icon: ReceiptText, labelKey: 'nav.tax', permission: 'tax.manage' },
    { to: '/channels', icon: Radio, labelKey: 'nav.channels', permission: 'channels.manage' },
    { to: '/integrations', icon: Plug, labelKey: 'nav.integrations', permission: 'settings.manage' },
    { to: '/communications', icon: Mail, labelKey: 'nav.communications', permission: 'communications.manage' },
    { to: '/reviews', icon: MessageSquare, labelKey: 'nav.reviews', permission: 'reviews.manage' },
    { to: '/settings?tab=users', icon: ShieldCheck, labelKey: 'nav.usersRoles', permission: 'admin.users.manage' },
    { to: '/import', icon: Upload, labelKey: 'nav.import', permission: 'settings.manage' },
    { to: '/settings', icon: Settings, labelKey: 'nav.settings', permission: 'settings.manage' },
  ] },
];

/** Preserve only tenant context, never carry a reservation/date/filter into another tool. */
export function propertyHref(to: string, propertyId: string | null): string {
  const [path, query] = to.split('?');
  const params = new URLSearchParams(query);
  if (propertyId && !params.has('propertyId')) params.set('propertyId', propertyId);
  const search = params.toString();
  return path + (search ? `?${search}` : '');
}

export function visibleNavigation(hasPermission: (permission: string) => boolean) {
  return NAVIGATION.map(section => ({ ...section, items: section.items.filter(item =>
    hasPermission(item.permission) && (item.to !== '/booking-requests' || isBookingRequestsUiEnabled()),
  ) })).filter(section => section.items.length);
}

/** Most specific query destination wins, so a tab never lights two menu entries. */
export function activeNavigationItem(pathname: string, search: string, items = NAVIGATION.flatMap(s => s.items)) {
  const current = new URLSearchParams(search);
  return items.filter(item => {
    const [path, query] = item.to.split('?');
    if (pathname !== path && !(path !== '/' && pathname.startsWith(path + '/'))) return false;
    return [...new URLSearchParams(query)].every(([key, value]) => current.get(key) === value);
  }).sort((a, b) => b.to.split('?')[0].length - a.to.split('?')[0].length ||
    new URLSearchParams(b.to.split('?')[1]).size - new URLSearchParams(a.to.split('?')[1]).size)[0]?.to;
}
