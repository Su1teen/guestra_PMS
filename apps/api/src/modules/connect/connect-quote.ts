import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
export interface ConnectAcceptedQuote {
  version: 'connect-quote-v2'; propertyId:string; roomTypeId:string; ratePlanId:string;
  checkIn:string;checkOut:string;adults:number;children:number;customerId:string;
  totalAmount:string;currency:string;lineItems:Array<{date:string;rate:string;tax:string}>;
  expiresAt:string;
}
export function canonical(value:unknown):string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const fingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export function signQuote(quote:ConnectAcceptedQuote,secret:string):string {
  if(secret.length<32) throw new BadRequestException('QUOTE_SIGNING_NOT_CONFIGURED');
  const body=Buffer.from(JSON.stringify(quote)).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
}
export function readQuote(token:string,secret:string):ConnectAcceptedQuote {
  const [body,signature,...extra]=token.split('.');
  const expected=createHmac('sha256',secret).update(body??'').digest();
  const supplied=Buffer.from(signature??'','base64url');
  if (secret.length<32 || extra.length || expected.length!==supplied.length || !timingSafeEqual(expected,supplied))
    throw new BadRequestException('INVALID_QUOTE');
  let quote:ConnectAcceptedQuote;
  try {quote=JSON.parse(Buffer.from(body!,'base64url').toString('utf8'));}catch{throw new BadRequestException('INVALID_QUOTE');}
  if(quote.version!=='connect-quote-v2' || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt)<=Date.now())
    throw new ConflictException('QUOTE_EXPIRED');
  return quote;
}
export function assertQuoteMatches(quote:ConnectAcceptedQuote,input:{propertyId:string;roomTypeId:string;ratePlanId:string;checkIn:string;checkOut:string;adults:number;children?:number;integrationContext?:{customerId?:string}}) {
  for (const name of ['propertyId','roomTypeId','ratePlanId','checkIn','checkOut','adults'] as const)
    if(quote[name]!==input[name]) throw new ConflictException('QUOTE_SCOPE_MISMATCH');
  if(quote.children!==(input.children??0) || quote.customerId!==input.integrationContext?.customerId)
    throw new ConflictException('QUOTE_SCOPE_MISMATCH');
}
