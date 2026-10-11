import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/helpers';
import { api } from '../lib/api';
import NightAudit from './NightAudit';
import i18n from '../i18n';

vi.mock('../lib/api',()=>({api:{get:vi.fn(),post:vi.fn()}}));
vi.mock('../context/PropertyContext',()=>({useProperty:()=>({propertyId:'test-property',currencyCode:'KZT'})}));
describe('night audit saved response compatibility',()=>{
  beforeEach(()=>vi.clearAllMocks());
  it('renders the existing seeded numeric anomaly count without slicing a number',async()=>{
    vi.mocked(api.get).mockImplementation(async url=>({data:url.includes('/decisions')?[{recommendation:{anomalies:1,topAnomaly:{type:'unposted_charge',severity:'warning'}}}]:[]}) as never);
    renderWithProviders(<NightAudit/>);
    expect(await screen.findByText(i18n.t('runtimeErrors.auditDetailsMissing'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('nightAudit.issuesFound',{count:1}))).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('renders detailed current anomalies with optional confidence and enveloped history',async()=>{
    vi.mocked(api.get).mockImplementation(async url=>({data:{data:url.includes('/decisions')?[{recommendation:{anomalies:[{description:'Unposted charge',severity:'warning'}]}}]:[]}}) as never);
    renderWithProviders(<NightAudit/>);
    expect(await screen.findByText('Unposted charge')).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('runtimeErrors.auditDetailsMissing'))).not.toBeInTheDocument();
  });
  it('isolates an invalid history response as a query error, preserving retry',async()=>{
    vi.mocked(api.get).mockImplementation(async url=>({data:url.includes('/decisions')?[]:{unexpected:true}}) as never);
    renderWithProviders(<NightAudit/>);
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Try Again'})).toBeInTheDocument();
  });
});
