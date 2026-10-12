import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../lib/money';
import { type ReceivablesSnapshot } from '../../lib/live-revenue';

export default function ReceivablesCurrencyNotice({ balances }: { balances?: ReceivablesSnapshot }) {
  const { i18n } = useTranslation();
  if (balances?.accountsReceivableCurrencyStatus !== 'CURRENCY_MISMATCH') return null;
  const ru = i18n.language.startsWith('ru');
  return <div role="alert" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
    <p>{ru
      ? 'Валюта дебиторской задолженности (A/R) отличается от валюты объекта. Общая сумма A/R недоступна без сверки и подтверждённой конвертации. Показатели выручки не включают A/R.'
      : 'Open receivables (A/R) differ from the property currency. The A/R total is unavailable without reconciliation and verified conversion. Revenue KPIs do not include A/R.'}</p>
    <ul className="mt-2 space-y-1">{balances.accountsReceivableByCurrency?.map(row => <li key={row.currencyCode}>
      {row.currencyCode} · {ru ? 'К оплате' : 'Due'}: {formatMoney(row.due, row.currencyCode, i18n.language)} · {ru ? 'Кредитовые остатки' : 'Credits'}: {formatMoney(row.credits, row.currencyCode, i18n.language)}
    </li>)}</ul>
  </div>;
}
