import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatMoney } from '../../lib/money';
import { reportedKpis } from '../../lib/financial-presentation';

export default function PortfolioRevenue({ data, names }: { data: any; names: Map<string, string> }) {
  return <div className="space-y-4">
    {data.currencyStatus === 'MIXED_CURRENCIES' && <p role="status">MIXED_CURRENCIES · Валюты показаны отдельно, без конвертации.</p>}
    {(data.byCurrency ?? []).map((group: any) => {
      const kpis = reportedKpis(group);
      const rows = (data.byProperty ?? []).filter((row: any) => row.currencyCode === group.currencyCode).map((row: any) => ({
        name: names.get(row.propertyId) ?? row.propertyId, revenue: reportedKpis(row).totalRevenue,
      }));
      return <section key={group.currencyCode} className="bg-white rounded-xl shadow-sm p-5">
        <h3 className="font-semibold">{group.currencyCode} · {formatMoney(kpis.totalRevenue, group.currencyCode)}</h3>
        <p className="text-xs text-telivity-mid-grey">{group.actual?.status} · {group.actual?.closedDays}/{group.actual?.expectedDays} · ADR {formatMoney(kpis.adr, group.currencyCode)} · RevPAR {formatMoney(kpis.revpar, group.currencyCode)}</p>
        <ResponsiveContainer width="100%" height={200}><BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value: number) => formatMoney(value, group.currencyCode)} /><Bar dataKey="revenue" fill="#06bdb4" radius={[4, 4, 0, 0]} />
        </BarChart></ResponsiveContainer>
        <div className="text-xs">{rows.filter((row: any) => row.revenue === null).map((row: any) => <p key={row.name}>{row.name}: — · NO_POSTINGS</p>)}</div>
      </section>;
    })}
  </div>;
}
