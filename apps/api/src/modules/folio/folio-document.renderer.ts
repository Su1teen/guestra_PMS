/**
 * Guest-facing folio document (interim folio or final receipt).
 * Pure presentation of ledger facts already computed by the folio service:
 * no amounts are derived here except summing what the caller supplies.
 * The same print layout is used by Guestra CRM, so a guest gets an identical
 * receipt whichever system the staff member closes the stay in.
 */
export interface FolioDocumentLine {
  date: string | null;
  description: string;
  amount: string;
  tax?: string | null;
}

export interface FolioDocumentPayment {
  date: string | null;
  method: string;
  reference?: string | null;
  amount: string;
}

export interface FolioDocumentData {
  final: boolean;
  folioNumber: string;
  issueDate: string;
  propertyName: string;
  propertyAddress?: string | null;
  propertyContact?: string | null;
  guestName: string;
  guestContact?: string | null;
  confirmationNumber?: string | null;
  roomNumber?: string | null;
  roomTypeName?: string | null;
  arrivalDate?: string | null;
  departureDate?: string | null;
  guests?: number | null;
  currencyCode: string;
  lines: FolioDocumentLine[];
  payments: FolioDocumentPayment[];
  totalCharges: string;
  totalPayments: string;
  balance: string;
  timeZone?: string | null;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  credit_card: 'Банковская карта',
  debit_card: 'Дебетовая карта',
  cash: 'Наличные',
  bank_transfer: 'Банковский перевод',
  pix: 'PIX',
  city_ledger: 'Счёт компании',
  vcc: 'Виртуальная карта',
  other: 'Другое',
};

export const paymentMethodLabel = (method: string) => PAYMENT_METHOD_LABELS[method] ?? method;

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const formatDate = (value: string | null | undefined, timeZone?: string | null) => {
  if (!value) return '';
  // Calendar dates (YYYY-MM-DD) are rendered as-is without a time-zone shift.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00Z') : new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'long', year: 'numeric',
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : timeZone ?? 'UTC',
  }).format(date);
};

export const formatDocumentMoney = (value: string | number, currency: string) => {
  const amount = Number(value);
  const formatted = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    .format(Number.isFinite(amount) ? amount : 0);
  return `${formatted} ${esc(currency === 'KZT' ? '₸' : currency)}`;
};

const row = (label: string, value: string) =>
  `<div class="meta-row"><span>${esc(label)}</span><strong>${value}</strong></div>`;

export function renderFolioDocument(data: FolioDocumentData): string {
  const title = data.final ? 'Итоговое фолио · квитанция' : 'Предварительное фолио';
  const money = (value: string | number) => formatDocumentMoney(value, data.currencyCode);
  const stay = [
    data.arrivalDate && `Заезд ${formatDate(data.arrivalDate)}`,
    data.departureDate && `Выезд ${formatDate(data.departureDate)}`,
    data.guests ? `${data.guests} гост.` : null,
  ].filter(Boolean).join(' · ');
  const room = [data.roomTypeName, data.roomNumber && `№ ${data.roomNumber}`].filter(Boolean).join(' · ');
  const subtitle = data.final
    ? Number(data.balance) === 0
      ? 'Счёт полностью оплачен'
      : 'Итоговый документ по проживанию'
    : 'Документ для гостя. Итоговые суммы фиксируются при выезде.';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} ${esc(data.folioNumber)}</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#1c2935;background:#e8ebef}*{box-sizing:border-box}body{margin:0}
.toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:center;gap:12px;padding:12px;background:#263a4c}
.toolbar button{border:0;border-radius:8px;padding:9px 16px;font:600 13px Arial;cursor:pointer}.toolbar .primary{background:#d9a66b;color:#182c3e}
.sheet{width:210mm;min-height:297mm;margin:26px auto;padding:20mm 18mm;background:white;box-shadow:0 14px 45px #1b304022}
.brand{font-size:14px;font-weight:800;letter-spacing:.1em;color:#9b673a}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #263a4c;padding-bottom:22px}
.top-right{text-align:right;color:#667582;font-size:12px}h1{font-size:27px;line-height:1.2;margin:30px 0 5px}h2{font-size:14px;margin:30px 0 12px}p{line-height:1.55}
.muted{color:#647484}.small{font-size:11px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin:22px 0;padding:18px;background:#f5f6f7}
.meta-row{display:flex;justify-content:space-between;gap:16px;margin:7px 0;font-size:12px}.meta-row span{color:#647484}.meta-row strong{text-align:right;font-weight:600}
table{width:100%;border-collapse:collapse;margin:14px 0 25px;font-size:12px}th{text-align:left;color:#647484;font-size:10px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #d7dce1}
th,td{padding:11px 7px;vertical-align:top}td{border-bottom:1px solid #e3e6e9}th.num,td.num{text-align:right;white-space:nowrap}
.totals{width:300px;max-width:100%;margin-left:auto}.total{border-top:2px solid #263a4c;padding-top:10px;font-size:16px}
.paid{display:inline-block;margin-top:6px;padding:4px 10px;border-radius:999px;background:#e5f4ee;color:#1f6b4f;font-size:12px;font-weight:600}
.footer{margin-top:40px;border-top:1px solid #d7dce1;padding-top:12px;color:#647484;font-size:10px}tr,.summary,.totals{break-inside:avoid}
@page{size:A4;margin:18mm}@media print{:root{background:white}.toolbar{display:none}.sheet{width:auto;min-height:auto;margin:0;box-shadow:none;padding:0}body{background:white}}
@media(max-width:850px){.sheet{width:100%;margin:0;padding:24px;min-height:100vh}.summary{grid-template-columns:1fr}}
</style></head><body><div class="toolbar"><button onclick="window.close()">Закрыть</button><button class="primary" onclick="window.print()">Печать / Сохранить PDF</button></div>
<main class="sheet"><header class="top"><div><div class="brand">GUESTRA</div><p><strong>${esc(data.propertyName)}</strong>${data.propertyAddress ? `<br>${esc(data.propertyAddress)}` : ''}${data.propertyContact ? `<br><span class="muted small">${esc(data.propertyContact)}</span>` : ''}</p></div>
<div class="top-right">№ ${esc(data.folioNumber)}<br>${formatDate(data.issueDate, data.timeZone)}</div></header>
<h1>${esc(title)}</h1><p class="muted">${esc(subtitle)}</p>${data.final && Number(data.balance) === 0 ? '<span class="paid">Оплачено</span>' : ''}
<section class="summary"><div>${row('Гость', esc(data.guestName))}${data.guestContact ? row('Контакт', esc(data.guestContact)) : ''}${data.confirmationNumber ? row('Бронь', esc(data.confirmationNumber)) : ''}</div>
<div>${room ? row('Номер', esc(room)) : ''}${stay ? row('Проживание', esc(stay)) : ''}</div></section>
<h2>Начисления</h2><table><thead><tr><th>Дата / позиция</th><th class="num">Налог</th><th class="num">Сумма</th></tr></thead><tbody>
${data.lines.length ? data.lines.map((line) => `<tr><td>${line.date ? `<span class="muted small">${formatDate(line.date, data.timeZone)}</span><br>` : ''}${esc(line.description)}</td><td class="num">${line.tax && Number(line.tax) !== 0 ? money(line.tax) : '—'}</td><td class="num">${money(line.amount)}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">Начислений нет</td></tr>'}
</tbody></table>
<section class="totals">${row('Начислено', money(data.totalCharges))}${row('Оплачено', money(data.totalPayments))}<div class="meta-row total"><span>Остаток к оплате</span><strong>${money(data.balance)}</strong></div></section>
${data.payments.length ? `<h2>Оплаты</h2><table><thead><tr><th>Дата</th><th>Способ / номер</th><th class="num">Сумма</th></tr></thead><tbody>${data.payments.map((p) => `<tr><td>${formatDate(p.date, data.timeZone)}</td><td>${esc(p.method)}${p.reference ? ` · ${esc(p.reference)}` : ''}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
<footer class="footer">${esc(data.propertyName)} · Фолио ${esc(data.folioNumber)} · ${formatDate(data.issueDate, data.timeZone)}</footer></main></body></html>`;
}
