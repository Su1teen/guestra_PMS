import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Gift, LockKeyhole } from 'lucide-react';
import './cashback-wallet.css';

type Entry = { id: string; type: 'earn' | 'release' | 'redeem'; amount: number; date: string; note: string };
type Category = 'stay' | 'fnb' | 'other';
const rates: Record<Category, { label: string; rate: number }> = {
  stay: { label: 'Проживание', rate: 0.05 },
  fnb: { label: 'F&B', rate: 0.03 },
  other: { label: 'Прочие услуги', rate: 0.04 },
};
const money = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} ₸`;
const keyFor = (guestId: string) => `guestra.cashback.demo.v1.${guestId}`;
function load(guestId: string): Entry[] {
  try {
    const stored = localStorage.getItem(keyFor(guestId));
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((row): row is Entry => row && typeof row.id === 'string' && ['earn', 'release', 'redeem'].includes(row.type) && Number.isFinite(row.amount)) : [];
  } catch { return []; }
}

/** The demo ledger is separate from PMS loyalty points and never writes to its API. */
export default function CashbackWallet({ guestId, guestName, eligibleSpend = 0, lastStayDate }: { guestId: string; guestName?: string; eligibleSpend?: number; lastStayDate?: string | null }) {
  const [entries, setEntries] = useState<Entry[]>(() => load(guestId));
  const [category, setCategory] = useState<Category>('stay');
  const [spend, setSpend] = useState('');
  const [check, setCheck] = useState('');
  const [redeem, setRedeem] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setEntries(load(guestId)); setNotice(''); }, [guestId]);
  const seed = useMemo(() => {
    const earned = Math.floor(Math.max(0, eligibleSpend) * 0.04 / 50) * 50;
    const spent = Math.floor(earned * 0.18 / 50) * 50;
    const daysSinceStay = lastStayDate ? Math.floor((new Date('2026-09-18T12:00:00').getTime() - new Date(lastStayDate).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY;
    const pending = daysSinceStay >= 0 && daysSinceStay <= 3 ? Math.floor(earned * 0.15 / 50) * 50 : 0;
    return { earned, spent, pending, available: earned - spent - pending };
  }, [eligibleSpend, lastStayDate]);
  const pending = Math.max(0, seed.pending + entries.filter((e) => e.type === 'earn').reduce((sum, e) => sum + e.amount, 0) - entries.filter((e) => e.type === 'release').reduce((sum, e) => sum + e.amount, 0));
  const available = Math.max(0, seed.available + entries.filter((e) => e.type === 'release').reduce((sum, e) => sum + e.amount, 0) - entries.filter((e) => e.type === 'redeem').reduce((sum, e) => sum + e.amount, 0));
  const earned = seed.earned + entries.filter((e) => e.type === 'earn').reduce((sum, e) => sum + e.amount, 0);
  const redeemed = seed.spent + entries.filter((e) => e.type === 'redeem').reduce((sum, e) => sum + e.amount, 0);
  const awardAmount = Math.floor(Number(spend || 0) * rates[category].rate);
  const maxRedeem = Math.min(available, Math.floor(Number(check || 0) * 0.2));

  function append(type: Entry['type'], amount: number, note: string) {
    const next = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type, amount, date: new Date().toISOString(), note }, ...entries];
    setEntries(next);
    try { localStorage.setItem(keyFor(guestId), JSON.stringify(next)); } catch { setNotice('Изменение видно до обновления страницы: браузер не сохранил демо-журнал.'); }
  }

  function award() {
    if (!Number.isFinite(Number(spend)) || Number(spend) <= 0 || awardAmount <= 0) { setNotice('Укажите положительную сумму покупки.'); return; }
    append('earn', awardAmount, `Кэшбек ${rates[category].label} · ${money(Number(spend))}`);
    setSpend(''); setNotice(`${money(awardAmount)} добавлено в ожидающие начисления.`);
  }
  function release() {
    if (!pending) return;
    append('release', pending, 'Зачисление ожидающего кэшбека (демо)');
    setNotice(`${money(pending)} теперь доступны гостю.`);
  }
  function burn() {
    const amount = Math.floor(Number(redeem));
    if (!Number.isFinite(amount) || amount <= 0 || amount > maxRedeem) { setNotice(`Можно списать до ${money(maxRedeem)} — 20% чека и в пределах баланса.`); return; }
    append('redeem', amount, `Демо-списание · чек ${money(Number(check))}`);
    setRedeem(''); setCheck(''); setNotice(`${money(amount)} списано только в демо-журнале.`);
  }

  const history = [
    ...entries,
    ...(seed.pending ? [{ id: 'base-pending', type: 'earn' as const, amount: seed.pending, date: lastStayDate ?? '2026-09-15T12:00:00', note: 'Кэшбек за последнее проживание · ожидает' }] : []),
    ...(seed.spent ? [{ id: 'base-redeem', type: 'redeem' as const, amount: seed.spent, date: lastStayDate ? new Date(new Date(lastStayDate).getTime() - 45 * 86_400_000).toISOString() : '2026-07-14T12:00:00', note: 'Оплата услуг бонусами' }] : []),
    ...(seed.available ? [{ id: 'base-earned', type: 'release' as const, amount: seed.available, date: lastStayDate ?? '2026-05-20T12:00:00', note: 'Кэшбек по завершённым визитам' }] : []),
  ];

  return <section className="cbw">
    <div className="cbw-head"><div><span className="cbw-kicker">GUESTRA REWARDS · ДЕМО</span><h3>Кэшбек гостя{guestName ? ` · ${guestName}` : ''}</h3><p>Единый аккаунт по сети ЛЕС · 1 бонус = 1 ₸</p></div><Gift size={25} /></div>
    <div className="cbw-balances"><div className="primary"><span>Доступно</span><strong>{money(available)}</strong></div><div><span>Ожидает</span><strong>{money(pending)}</strong></div><div><span>Начислено всего</span><strong>{money(earned)}</strong></div><div><span>Использовано</span><strong>{money(redeemed)}</strong></div></div>
    <div className="cbw-body">
      <div className="cbw-actions">
        <div className="cbw-block"><h4>Начислить кэшбек</h4><p>После услуги сумма попадает в ожидающие. Правила демо: проживание 5%, F&B 3%, прочее 4%.</p><div className="cbw-inputs"><label>Направление<select value={category} onChange={(event) => setCategory(event.target.value as Category)}>{Object.entries(rates).map(([value, item]) => <option key={value} value={value}>{item.label} · {Math.round(item.rate * 100)}%</option>)}</select></label><label>Сумма покупки, ₸<input type="number" min="1" step="1" value={spend} onChange={(event) => setSpend(event.target.value)} placeholder="Например, 120000" /></label></div><div className="cbw-action-row"><span>К начислению <strong>{money(awardAmount > 0 ? awardAmount : 0)}</strong></span><button type="button" onClick={award}>Начислить</button></div>{pending > 0 && <button type="button" className="cbw-secondary" onClick={release}>Зачислить ожидающие · {money(pending)}</button>}</div>
        <div className="cbw-block"><h4>Проверить списание</h4><p>До 20% чека, в пределах доступного баланса. В фолио PMS операция не проводится.</p><div className="cbw-inputs"><label>Сумма чека, ₸<input type="number" min="1" step="1" value={check} onChange={(event) => setCheck(event.target.value)} placeholder="Например, 80000" /></label><label>Списать, ₸<input type="number" min="1" step="1" value={redeem} onChange={(event) => setRedeem(event.target.value)} placeholder="Бонусы" /></label></div><div className="cbw-action-row"><span>Доступный лимит <strong>{money(maxRedeem)}</strong></span><button type="button" className="outline" onClick={burn}>Списать</button></div></div>
      </div>
      <div className="cbw-history"><h4>История аккаунта</h4><p>Начисления, ожидание и списания видны в одном журнале.</p><div className="cbw-events">{history.length ? history.map((entry) => <div key={entry.id} className="cbw-event"><span className={entry.type === 'redeem' ? 'out' : 'in'}>{entry.type === 'redeem' ? <ArrowUpRight size={17} /> : <ArrowDownLeft size={17} />}</span><div><strong>{entry.note}</strong><small>{new Date(entry.date).toLocaleDateString('ru-RU')} · {entry.type === 'earn' ? 'ожидает' : entry.type === 'release' ? 'доступно' : 'списано'}</small></div><b className={entry.type === 'redeem' ? 'negative' : ''}>{entry.type === 'redeem' ? '−' : '+'}{money(entry.amount)}</b></div>) : <div className="cbw-empty">У гостя пока нет начислений</div>}</div></div>
    </div>
    {notice && <div className="cbw-notice" role="status">{notice}</div>}
    <p className="cbw-disclaimer"><LockKeyhole size={13} /> Демо-журнал хранится только в этом браузере. Действующие баллы PMS и база данных не изменяются.</p>
  </section>;
}
