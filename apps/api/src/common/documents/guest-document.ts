/** Shared building blocks for printable guest documents (proposal, confirmation, folio statement). */

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function money(value: string, currency: string, lang: string) {
  return `${new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${currency}`;
}

export function day(value: string, lang: string, short = false) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', short
    ? { day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC' }
    : { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(value + 'T00:00:00Z'));
}

export function moment(iso: string, lang: string) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}

/** Shared print stylesheet for guest documents (A4, readable on screen and paper). */
export const DOCUMENT_CSS = `
*{box-sizing:border-box}body{margin:0;background:#F3F4F6;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;color:#101828;-webkit-font-smoothing:antialiased}
.sheet{max-width:794px;margin:24px auto;background:#fff;padding:40px 44px;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.08)}
header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:2px solid #101828;padding-bottom:16px}
h1{font-size:24px;line-height:1.25;margin:0}h2{font-size:15px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#344054}
.muted{color:#5D6679;font-size:13px}.hotel{text-align:right;font-size:13px;color:#344054;line-height:1.5}
.badge{display:inline-block;margin-top:8px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.ok{background:#ECFDF3;color:#067647}.badge.wait{background:#FFFAEB;color:#B54708}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.facts th{text-align:left;width:38%;color:#5D6679;font-weight:500}.facts th,.facts td{padding:9px 0;border-bottom:1px solid #EAECF0;font-size:14px;vertical-align:top}
.facts td{font-weight:600}
.grid th{font-size:12px;color:#5D6679;font-weight:600;text-align:left;padding:8px;background:#F9FAFB;border-bottom:1px solid #EAECF0}
.grid td{font-size:13px;padding:8px;border-bottom:1px solid #F2F4F7}.grid .num{text-align:right;white-space:nowrap}
.grid tfoot td{font-weight:700;border-top:1px solid #D0D5DD;border-bottom:0}
.room{margin-top:14px;border:1px solid #EAECF0;border-radius:10px;overflow:hidden}.room-head{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;background:#F9FAFB;font-size:13px}
.room-head strong{font-size:14px}.supp{padding:8px 12px;font-size:12px;color:#344054;border-top:1px solid #EAECF0}
.totals td{padding:7px 0;font-size:14px}.totals .num{text-align:right}.totals .grand td{font-size:18px;font-weight:700;border-top:2px solid #101828;padding-top:10px}
.callout{margin-top:20px;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.5}.callout.wait{background:#FFFAEB;border:1px solid #FEDF89}
.callout.ok{background:#ECFDF3;border:1px solid #ABEFC6}.callout b{display:block;margin-bottom:4px}
p{font-size:14px;line-height:1.55;margin:6px 0}.no-print{display:flex;justify-content:flex-end;margin-bottom:12px}
.no-print button{min-height:40px;padding:0 18px;border:0;border-radius:8px;background:#3657E8;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
@page{size:A4;margin:14mm}@media print{body{background:#fff}.sheet{margin:0;padding:0;box-shadow:none;max-width:none}.no-print{display:none}.room{break-inside:avoid}}`;

