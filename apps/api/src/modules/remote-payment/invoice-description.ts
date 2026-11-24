/** What the guest sees in Kaspi is cut at 60 characters, so the text is composed to fit instead of being sliced mid-word. */
export const INVOICE_DESCRIPTION_LIMIT = 60;

export function invoiceDescription(confirmationNumber?: string | null, propertyName?: string | null): string {
  const base = 'Предоплата брони';
  const number = confirmationNumber?.trim() ?? '';
  const name = propertyName?.trim() ?? '';
  const fits = (text: string) => text.length <= INVOICE_DESCRIPTION_LIMIT;
  if (!number) return fits(`${base}, ${name}`) && name ? `${base}, ${name}` : base;
  const withName = `${base} ${number}, ${name}`;
  if (name && fits(withName)) return withName;
  const plain = `${base} ${number}`;
  if (fits(plain)) return plain;
  // A very long number: keep its tail, which is what staff recognise.
  const short = `${base} …${number.slice(-10)}`;
  return name && fits(`${short}, ${name}`) ? `${short}, ${name}` : short;
}
