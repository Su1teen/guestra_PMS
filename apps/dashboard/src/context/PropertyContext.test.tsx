import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useNavigate } from 'react-router-dom';
import { PropertyProvider, useProperty } from './PropertyContext';
import { api, setPropertyId } from '../lib/api';
import { propertyHref } from '../lib/navigation';

vi.mock('../lib/api',()=>({api:{get:vi.fn()},setPropertyId:vi.fn()}));
vi.mock('../lib/socket',()=>({joinPropertyRoom:vi.fn(),leavePropertyRoom:vi.fn()}));
function Scope() {
  const scope=useProperty();const navigate=useNavigate();
  return <><p data-testid="property">{scope.propertyId}</p><p data-testid="loading">{String(scope.propertiesLoading)}</p>
    <button onClick={()=>scope.setPropertyId('b')}>Switch property</button>
    <Link to={propertyHref('/reports?report=daily-revenue',scope.propertyId)}>Report link</Link>
    <Link to="/guests?propertyId=a">Property A</Link><button onClick={()=>navigate(-1)}>Back</button></>;
}
describe('property context navigation',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    vi.mocked(api.get).mockImplementation(async url=>({data:url.includes('properties')?[{id:'a',currencyCode:'KZT'},{id:'b',currencyCode:'EUR'}]:[]}) as never);
  });
  it('preserves scope in cross-section links and follows browser history',async()=>{
    render(<MemoryRouter initialEntries={['/revenue?propertyId=a']}><PropertyProvider><Scope/></PropertyProvider></MemoryRouter>);
    await waitFor(()=>expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await userEvent.click(screen.getByText('Switch property'));expect(screen.getByTestId('property')).toHaveTextContent('b');
    expect(setPropertyId).toHaveBeenLastCalledWith('b');
    expect(screen.getByText('Report link')).toHaveAttribute('href','/reports?report=daily-revenue&propertyId=b');
    await userEvent.click(screen.getByText('Property A'));expect(screen.getByTestId('property')).toHaveTextContent('a');
    await userEvent.click(screen.getByText('Back'));expect(screen.getByTestId('property')).toHaveTextContent('b');
    expect(setPropertyId).toHaveBeenLastCalledWith('b');
  });
  it('does not replace an explicit scope while bootstrap is loading',async()=>{
    let resolve!: (value:unknown)=>void;
    vi.mocked(api.get).mockImplementation(url=>url.includes('properties')?new Promise(r=>{resolve=r;}) as never:Promise.resolve({data:[]}) as never);
    render(<MemoryRouter initialEntries={['/']}><PropertyProvider><Scope/></PropertyProvider></MemoryRouter>);
    await userEvent.click(screen.getByText('Switch property'));
    resolve({data:[{id:'a'},{id:'b'}]});await waitFor(()=>expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('property')).toHaveTextContent('b');
  });
  it('selects portfolio only from the real returned property list and clears the default API scope',async()=>{
    render(<MemoryRouter><PropertyProvider><Scope/></PropertyProvider></MemoryRouter>);
    await waitFor(()=>expect(screen.getByTestId('property')).toHaveTextContent('portfolio'));
    expect(setPropertyId).toHaveBeenLastCalledWith(null);
  });
});
