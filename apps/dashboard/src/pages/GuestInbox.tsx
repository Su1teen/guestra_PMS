import {useEffect,useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {Link} from 'react-router-dom';
import {MessageSquare,UserRound} from 'lucide-react';
import {api} from '../lib/api';
import {useProperty} from '../context/PropertyContext';
import {propertyHref} from '../lib/navigation';

interface Conversation {id:string;customerId:string;customerName:string;channel:string;status:string;automationMode:string;unreadCount:number}
interface Message {id:string;text:string;direction:string;at:string;deliveryStatus:string;attachments?:{id:string;fileName?:string;processingStatus:string}[]}
interface OperationalContext {
  verifiedGuest:boolean;
  reservations?:{id:string;status:string;arrivalDate:string;departureDate:string}[];
  services?:{id:string;status:string;startAt:string;endAt:string}[];
  requests?:{id:string;status:string;title:string}[];
  folios?:{id:string;balance:string;currencyCode:string;receivedAmount:string}[];
}
export default function GuestInbox() {
  const {t}=useTranslation(),{propertyId}=useProperty(),cache=useQueryClient();
  const [selected,setSelected]=useState<string|null>(null);
  useEffect(()=>setSelected(null),[propertyId]);
  const enabled=import.meta.env.VITE_GUESTRA_INBOX_ENABLED==='true';
  const list=useQuery({queryKey:['guest-inbox',propertyId],enabled:enabled&&!!propertyId,
    queryFn:()=>api.get('/v1/guest-inbox',{params:{propertyId},isSilentPoll:true}).then(r=>r.data as {conversations:Conversation[]}),
    refetchInterval:15000});
  const detail=useQuery({queryKey:['guest-inbox',propertyId,selected],enabled:enabled&&!!propertyId&&!!selected,
    queryFn:()=>api.get('/v1/guest-inbox/'+encodeURIComponent(selected!),{params:{propertyId},isSilentPoll:true})
      .then(r=>r.data as {id:string;automationMode:string;messages:Message[];hasOlderMessages:boolean;operationalContext:OperationalContext}),
    refetchInterval:10000});
  const takeover=useMutation({mutationFn:()=>api.post('/v1/guest-inbox/'+encodeURIComponent(selected!)+'/takeover',{},
    {params:{propertyId}}),onSuccess:()=>cache.invalidateQueries({queryKey:['guest-inbox',propertyId]})});
  const conversations=list.data?.conversations??[],current=conversations.find(c=>c.id===selected);
  const context=detail.data?.operationalContext;
  if(!enabled)return <div className="p-6"><h1 className="text-2xl font-semibold">{t('guestInbox.title')}</h1><p className="mt-4">{t('guestInbox.disabled')}</p></div>;
  if(!propertyId)return <p className="p-6">{t('guestInbox.selectProperty')}</p>;
  return <div className="p-4 md:p-6 space-y-4">
    <h1 className="text-2xl font-semibold flex items-center gap-2"><MessageSquare size={24}/>{t('guestInbox.title')}</h1>
    {(list.isError||detail.isError||takeover.isError)&&<div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-800">{t('guestInbox.unavailable')}</div>}
    <div className="grid gap-4 lg:grid-cols-[280px_1fr_300px]">
      <aside className="rounded-xl border bg-white p-2 space-y-1">
        {list.isLoading&&<p className="p-3">{t('guestInbox.loading')}</p>}
        {!list.isLoading&&!conversations.length&&!list.isError&&<p className="p-3">{t('guestInbox.empty')}</p>}
        {conversations.map(c=><button key={c.id} onClick={()=>setSelected(c.id)} className={'w-full text-left rounded-lg p-3 '+(selected===c.id?'bg-blue-50':'hover:bg-gray-50')}>
          <div className="font-medium">{c.customerName}{c.unreadCount>0&&<span className="ml-2 rounded bg-blue-600 px-2 text-xs text-white">{c.unreadCount}</span>}</div>
          <div className="text-xs text-gray-500">{c.channel} · {t('guestInbox.'+(c.automationMode==='ai'?'ai':'human'))}</div>
        </button>)}
      </aside>
      <section className="rounded-xl border bg-white p-4 min-h-[400px]">
        {!selected?<p className="text-gray-500">{t('guestInbox.selectConversation')}</p>:<>
          <div className="flex flex-wrap justify-between gap-2 border-b pb-3">
            <strong>{current?.customerName}</strong>
            <button className="rounded border px-3 py-1 disabled:opacity-50" disabled={takeover.isPending||detail.data?.automationMode==='human'||!detail.data}
              onClick={()=>takeover.mutate()}><UserRound size={14} className="inline mr-1"/>{t('guestInbox.takeover')}</button>
          </div>
          {detail.isLoading&&<p className="py-4">{t('guestInbox.loading')}</p>}
          {detail.data?.hasOlderMessages&&<p className="text-xs text-gray-500 py-2">{t('guestInbox.recentMessages')}</p>}
          <div className="space-y-3 py-4">{detail.data?.messages.map(m=><article key={m.id} className={'rounded-lg p-3 max-w-[90%] '+(m.direction==='in'?'bg-gray-100':'bg-blue-50 ml-auto')}>
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
            {m.attachments?.map(a=><p key={a.id} className="text-sm mt-1">{a.fileName||t('guestInbox.attachment')} · {t('guestInbox.states.'+a.processingStatus,{defaultValue:a.processingStatus})}</p>)}
            <p className="mt-1 text-xs text-gray-500">{new Date(m.at).toLocaleString()} · {t('guestInbox.states.'+m.deliveryStatus,{defaultValue:m.deliveryStatus})}</p>
          </article>)}</div>
        </>}
      </section>
      <aside className="rounded-xl border bg-white p-4 space-y-4">
        <h2 className="font-semibold">{t('guestInbox.context')}</h2>
        {context&&!context.verifiedGuest&&<p className="text-sm text-gray-500">{t('guestInbox.noStay')}</p>}
        {context?.reservations?.map(r=><div key={r.id} className="text-sm">
          <Link className="text-blue-600 underline" to={propertyHref('/reservations/'+r.id,propertyId)}>{r.arrivalDate} — {r.departureDate}</Link><p>{t('guestInbox.states.'+r.status,{defaultValue:r.status})}</p>
        </div>)}
        {!!context?.services?.length&&<h3 className="font-medium text-sm">{t('guestInbox.services')}</h3>}
        {context?.services?.map(s=><p key={s.id} className="text-sm">{new Date(s.startAt).toLocaleString()} · {t('guestInbox.states.'+s.status,{defaultValue:s.status})}</p>)}
        {!!context?.requests?.length&&<h3 className="font-medium text-sm">{t('guestInbox.requests')}</h3>}
        {context?.requests?.map(r=><p key={r.id} className="text-sm">{r.title} · {t('guestInbox.states.'+r.status,{defaultValue:r.status})}</p>)}
        {!!context?.folios?.length&&<h3 className="font-medium text-sm">{t('guestInbox.finance')}</h3>}
        {context?.folios?.map(f=><div key={f.id} className="text-sm"><p>{t('guestInbox.balance')}: {f.balance} {f.currencyCode}</p>
          <p>{t('guestInbox.received')}: {f.receivedAmount} {f.currencyCode}</p></div>)}
      </aside>
    </div>
  </div>;
}
