import { api, dirPath } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { upsert } from './build-signer.mjs';
import { T } from './target.mjs';
const created = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8'));
const CRM = T.crmUrl;
export const NAMES = { gateway: T.gateway };

// Fields the agent's tool nodes can provide ($fromAI) plus the fixed identity/trace fields supplied by the parent.
export const GATEWAY_INPUTS = ['tool', 'externalUserId', 'conversationId', 'correlationId', 'executionRef', 'promptVersion', 'runId', 'inboundMessageId', 'allowedActions',
  'q', 'topic', 'checkIn', 'checkOut', 'adults', 'children', 'serviceId', 'startAt', 'endAt', 'quantity', 'participants',
  'direction', 'category', 'specialRequest', 'reasonCode', 'summary', 'requestedAction', 'priority',
  'requestId', 'roomTypeId', 'ratePlanId', 'offerId', 'operationId', 'guestConfirmed', 'activeProposal'];

const build = `
const i = $input.first().json;
const P = '${T.prop.crmPropertyId}';
const fail = (code, message) => [{ json: { blocked: true, ok: false, code, message } }];
const TOOLS = {
  get_property_knowledge: 'get_property_knowledge', search_accommodation: 'search_accommodation', get_service_catalog: 'book_service',
  check_service_availability: 'book_service', create_or_update_request: 'create_or_update_request', handoff_to_human: 'handoff_to_human',
  create_offer: 'create_pms_offer', book_accommodation: 'book_accommodation', get_operation_status: 'book_accommodation',
};
const need = TOOLS[i.tool];
if (!need) return fail('TOOL_NOT_ALLOWED', 'Неизвестный инструмент');
let allowed = []; try { allowed = JSON.parse(i.allowedActions || '[]'); } catch (e) { return fail('CONTEXT_INVALID', 'Нет списка разрешённых действий'); }
if (!allowed.includes(need)) return fail('ACTION_NOT_ALLOWED', 'Действие сейчас недоступно для этого диалога');
if (!i.externalUserId || !i.conversationId) return fail('IDENTITY_REQUIRED', 'Нет идентификатора диалога');
const id = { propertyId: P, channel: 'simulator', externalUserId: i.externalUserId, conversationId: i.conversationId };
const trace = { correlationId: i.correlationId, executionReference: i.executionRef, promptVersion: i.promptVersion };
const date = (v, name) => { if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || ''))) throw new Error(name + ' должен быть датой ГГГГ-ММ-ДД'); return v; };
const int = (v, name, min, max, def) => { if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw new Error(name + ' обязателен'); } const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ' должен быть целым от ' + min + ' до ' + max); return n; };
const today = new Date().toISOString().slice(0, 10);
const stay = () => {
  const a = date(i.checkIn, 'checkIn'), b = date(i.checkOut, 'checkOut');
  if (a < today) throw new Error('Дата заезда в прошлом');
  const nights = (Date.parse(b) - Date.parse(a)) / 86400000;
  if (!(nights >= 1 && nights <= 30)) throw new Error('Период проживания должен быть от 1 до 30 ночей');
  return [a, b];
};
const iso = d => d + 'T12:00:00+05:00';
const clip = (v, n) => (v === undefined || v === null || v === '' ? undefined : String(v).slice(0, n));
try {
  let r;
  switch (i.tool) {
    case 'get_property_knowledge':
      // The knowledge base is small: return it whole and let the model pick. A guessed q/topic filter would silently hide valid entries.
      r = { method: 'GET', path: '/property-knowledge', qs: { propertyId: P, language: 'ru', limit: 20 } }; break;
    case 'search_accommodation': {
      const [a, b] = stay();
      r = { method: 'POST', path: '/v2/accommodations/search', body: { ...id, checkIn: a, checkOut: b, adults: int(i.adults, 'adults', 1, 20), children: int(i.children, 'children', 0, 20, 0) } }; break; }
    case 'get_service_catalog':
      r = { method: 'GET', path: '/v2/services', qs: { ...id } }; break;
    case 'check_service_availability': {
      if (!/^[0-9a-f-]{36}$/i.test(String(i.serviceId || ''))) throw new Error('serviceId должен быть идентификатором из каталога услуг');
      r = { method: 'POST', path: '/v2/services/availability', body: { ...id, serviceId: i.serviceId, startAt: new Date(i.startAt).toISOString(), endAt: new Date(i.endAt).toISOString(),
        quantity: int(i.quantity, 'quantity', 1, 100, 1), participants: int(i.participants, 'participants', 1, 100, 1) } }; break; }
    case 'create_or_update_request': {
      const dir = ['accommodation', 'restaurant', 'spa', 'massage', 'bathhouse', 'karaoke', 'activities', 'transfer', 'corporate_event', 'wedding_or_banquet'];
      if (!dir.includes(i.direction)) throw new Error('direction должен быть одним из: ' + dir.join(', '));
      const body = { ...id, idempotencyKey: ('req:' + i.runId).slice(0, 120), direction: i.direction, quality: 'target', temperature: 'warm', probability: 30 };
      if (i.checkIn && i.checkOut) { const [a, b] = stay(); body.checkIn = iso(a); body.checkOut = iso(b); }
      if (i.adults !== undefined && i.adults !== '') body.adults = int(i.adults, 'adults', 0, 50);
      if (i.children !== undefined && i.children !== '') body.children = int(i.children, 'children', 0, 50);
      if (clip(i.category, 120)) body.category = clip(i.category, 120);
      if (clip(i.specialRequest, 1000)) body.specialRequest = clip(i.specialRequest, 1000);
      r = { method: 'POST', path: '/requests/upsert', body }; break; }
    case 'create_offer': {
      const uuidRe = /^[0-9a-f-]{36}$/i;
      if (!i.requestId) throw new Error('requestId обязателен: сначала создайте запрос и возьмите его requestId');
      if (!uuidRe.test(String(i.roomTypeId || '')) || !uuidRe.test(String(i.ratePlanId || ''))) throw new Error('roomTypeId и ratePlanId берите только из результата поиска размещения');
      r = { method: 'POST', path: '/v2/offers', body: { ...id, requestId: String(i.requestId), roomTypeId: i.roomTypeId, ratePlanId: i.ratePlanId, idempotencyKey: ('offer:' + i.runId + ':' + i.roomTypeId.slice(0, 8) + ':' + i.ratePlanId.slice(0, 8)).slice(0, 120) } }; break; }
    case 'book_accommodation': {
      if (String(i.guestConfirmed).toLowerCase() !== 'true') throw new Error('Бронь возможна только после явного подтверждения гостем отправленного предложения');
      let ap = null; try { ap = JSON.parse(i.activeProposal || 'null'); } catch (e) { ap = null; }
      if (!ap || ap.actionType !== 'book_accommodation' || !ap.payload?.offerId || !ap.messageId) throw new Error('Нет доставленного предложения, ожидающего подтверждения. Сначала подготовьте предложение и дождитесь ответа гостя');
      if (!i.inboundMessageId) throw new Error('Нет сообщения гостя с подтверждением');
      r = { method: 'POST', path: '/v2/accommodations/book', body: { ...id, offerId: ap.payload.offerId, proposalMessageId: ap.messageId, confirmationMessageId: i.inboundMessageId,
        idempotencyKey: ('book:' + ap.messageId + ':' + i.inboundMessageId).slice(0, 120) } }; break; }
    case 'get_operation_status': {
      if (!i.operationId) throw new Error('operationId обязателен');
      r = { method: 'GET', path: '/v2/operations/' + encodeURIComponent(String(i.operationId)), qs: { ...id } }; break; }
    case 'handoff_to_human': {
      const codes = ['custom_discount', 'refund_or_payment_issue', 'complaint_or_conflict', 'uncertain_intent', 'unavailable_nonstandard_solution', 'corporate_or_event_complex', 'guest_requested_human', 'unsupported_action'];
      if (!codes.includes(i.reasonCode)) throw new Error('reasonCode должен быть одним из: ' + codes.join(', '));
      const pr = ['low', 'medium', 'high', 'urgent'].includes(i.priority) ? i.priority : 'medium';
      r = { method: 'POST', path: '/handoff', body: { ...id, reasonCode: i.reasonCode, summary: clip(i.summary, 1000), requestedAction: clip(i.requestedAction, 500), priority: pr } }; break; }
  }
  const qs = { ...(r.qs || {}), ...trace };
  return [{ json: { blocked: false, tool: i.tool, method: r.method, url: ${JSON.stringify(CRM)} + r.path + '?' + Object.entries(qs).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&'),
    hasBody: !!r.body, bodyJson: r.body ? JSON.stringify(r.body) : '' } }];
} catch (e) { return fail('VALIDATION_ERROR', String(e.message).slice(0, 300)); }`;

const shape = `
const b = $('Build request').first().json;
if (b.blocked) return [{ json: { ok: false, code: b.code, message: b.message } }];
const r = $input.first().json;
const status = r.statusCode ?? 0;
const raw = r.data ?? r.body; let data; try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { data = undefined; }
if (status < 200 || status >= 300) {
  const code = data?.code || ('HTTP_' + status);
  const msg = { SCOPE_DENIED: 'Нет прав на это действие', BUSINESS_WRITES_DISABLED: 'Изменения сейчас отключены', VALIDATION_ERROR: 'Некорректные параметры запроса', CONVERSATION_HUMAN_OWNED: 'Диалог ведёт сотрудник' }[code] || 'Запрос не выполнен';
  return [{ json: { ok: false, status, code, retryable: !!data?.retryable || status >= 500, message: msg } }];
}
let out = data;
if (b.tool === 'search_accommodation') {
  out = { source: data.source, results: (data.results || []).map(p => ({ property: p.propertyName, roomTypes: (p.roomTypes || []).map(t => ({
    roomTypeId: t.roomTypeId, roomTypeName: t.roomTypeName, maxOccupancy: t.maxOccupancy, available: t.available,
    rates: (t.rates || []).map(x => ({ ratePlanId: x.ratePlanId, ratePlanName: x.ratePlanName, totalAmount: x.totalAmount, currency: x.currencyCode, nights: (x.nightlyBreakdown || []).length })) })) })) };
} else if (b.tool === 'get_property_knowledge') {
  out = { items: (data.items || []).slice(0, 20).map(x => ({ topic: x.topic, title: x.title, content: x.content })) };
} else if (b.tool === 'create_offer') {
  const o = data.offer ?? {}; const p = data.pricing ?? {};
  out = { offerId: o.id, offerCode: o.code, roomType: o.roomType, checkIn: o.checkIn, checkOut: o.checkOut, nights: o.nights, adults: o.adults, children: o.children, total: o.total, currency: p.currency ?? 'KZT', expiresAt: o.expiresAt, duplicate: data.duplicate };
} else if (b.tool === 'book_accommodation' || b.tool === 'get_operation_status') {
  const s = data.snapshot ?? data.result ?? {};
  out = { operationId: data.operationId, status: data.status, errorCode: data.errorCode, confirmationNumber: s.confirmationNumber ?? s.reservation?.confirmationNumber, reservationStatus: s.status ?? s.reservation?.status, totalAmount: s.totalAmount, currency: s.currencyCode ?? s.currency, arrivalDate: s.arrivalDate, departureDate: s.departureDate, snapshotKeys: Object.keys(s).slice(0, 20), duplicate: data.duplicate };
} else if (b.tool === 'create_or_update_request') {
  out = { requestId: data.requestId, created: data.created, duplicate: data.duplicate };
}
return [{ json: { ok: true, status, data: out } }];`;

export const gatewayWorkflow = {
  name: NAMES.gateway,
  nodes: [
    { id: 'g1', name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: GATEWAY_INPUTS.map(name => ({ name, type: 'string' })) } } },
    { id: 'g2', name: 'Build request', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: build } },
    { id: 'g3', name: 'Blocked?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0], parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, combinator: 'and',
        conditions: [{ id: 'c1', leftValue: '={{ $json.blocked }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] }, options: {} } },
    { id: 'g4', name: 'Is POST?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [660, 100], parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, combinator: 'and',
        conditions: [{ id: 'c2', leftValue: '={{ $json.hasBody }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] }, options: {} } },
    { id: 'g5', name: 'CRM POST', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [880, 40], retryOnFail: true, maxTries: 2, waitBetweenTries: 1000,
      credentials: { httpHeaderAuth: { id: created.crmCred, name: T.cred.crm } },
      parameters: { method: 'POST', url: '={{ $json.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.bodyJson }}',
        options: { timeout: 20000, response: { response: { neverError: true, fullResponse: true, responseFormat: 'text' } } } } },
    { id: 'g6', name: 'CRM GET', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [880, 180], retryOnFail: true, maxTries: 2, waitBetweenTries: 1000,
      credentials: { httpHeaderAuth: { id: created.crmCred, name: T.cred.crm } },
      parameters: { method: 'GET', url: '={{ $json.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        options: { timeout: 20000, response: { response: { neverError: true, fullResponse: true, responseFormat: 'text' } } } } },
    { id: 'g7', name: 'Shape result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1100, 100], parameters: { jsCode: shape } },
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Build request', type: 'main', index: 0 }]] },
    'Build request': { main: [[{ node: 'Blocked?', type: 'main', index: 0 }]] },
    'Blocked?': { main: [[{ node: 'Shape result', type: 'main', index: 0 }], [{ node: 'Is POST?', type: 'main', index: 0 }]] },
    'Is POST?': { main: [[{ node: 'CRM POST', type: 'main', index: 0 }], [{ node: 'CRM GET', type: 'main', index: 0 }]] },
    'CRM POST': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
    'CRM GET': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

if (process.argv[1]?.endsWith('build-gateway.mjs')) {
  const r = await upsert(gatewayWorkflow);
  console.log('gateway workflow', r.status, r.id, r.status !== 200 ? JSON.stringify(r.body).slice(0, 600) : '');
  if (r.status === 200) {
    const p = await api('POST', `/workflows/${r.id}/activate`, {}); console.log('publish', p.status, p.status !== 200 ? JSON.stringify(p.body).slice(0, 300) : '');
    const state = JSON.parse(readFileSync(dirPath + 'created.json', 'utf8')); state.gatewayId = r.id; writeFileSync(dirPath + 'created.json', JSON.stringify(state, null, 1));
  }
}
