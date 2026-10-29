import { api } from './api';
import { errorMessage } from './error-message';

/**
 * Opens the printable folio (interim or final receipt) in a new tab.
 * The tab is opened synchronously inside the click so popup blockers allow it;
 * the authenticated HTML is then loaded into it as a same-origin blob.
 */
export async function openFolioDocument(folioId: string, propertyId: string) {
  const tab = window.open('', '_blank');
  if (tab) tab.document.write('<p style="font-family:Arial;padding:24px">Формируем документ…</p>');
  try {
    const { data } = await api.get<string>(`/v1/folios/${folioId}/document`, {
      params: { propertyId }, responseType: 'text', skipErrorToast: true,
    });
    const url = URL.createObjectURL(new Blob([data], { type: 'text/html;charset=utf-8' }));
    if (tab) tab.location.href = url; else window.open(url, '_blank');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    if (tab) tab.close();
    throw new Error(errorMessage(error), { cause: error });
  }
}
