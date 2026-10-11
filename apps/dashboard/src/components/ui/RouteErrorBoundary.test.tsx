import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import RouteErrorBoundary from './RouteErrorBoundary';
import { Suspense } from 'react';
import { recoverableLazy } from '../../lib/recoverable-lazy';
import { ErrorBoundary, QueryError } from './ErrorBoundary';
import RouteAccess from './RouteAccess';
import { useAuth } from '../../context/AuthContext';
import { useState } from 'react';

const scope=vi.hoisted(()=>({propertyId:'a'}));
vi.mock('../../context/PropertyContext',()=>({useProperty:()=>scope}));

vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn(() => ({hasPermission:()=>true})) }));

function Broken(): null { throw new Error('Private diagnostic'); }
afterEach(() => vi.restoreAllMocks());

describe('route recovery', () => {
  it('keeps the navigation available and opens a healthy route after a render failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MemoryRouter initialEntries={['/broken']}>
      <Link to="/healthy">Open healthy section</Link>
      <RouteErrorBoundary><Routes>
        <Route path="/broken" element={<Broken />} />
        <Route path="/healthy" element={<p>Healthy section</p>} />
      </Routes></RouteErrorBoundary>
    </MemoryRouter>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Open healthy section'));
    expect(screen.getByText('Healthy section')).toBeInTheDocument();
  });
  it('can retry the current render without reloading the app', async () => {
    vi.spyOn(console,'error').mockImplementation(()=>{});
    let broken=true;
    function Page(){if(broken)throw Error('private');return <p>Recovered section</p>;}
    render(<ErrorBoundary><Page/></ErrorBoundary>);
    broken=false;await userEvent.click(screen.getByRole('button',{name:'Try Again'}));
    expect(screen.getByText('Recovered section')).toBeInTheDocument();
  });
  it('retries a cached rejected lazy import explicitly without an automatic reload loop', async () => {
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const importer=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: private-url')).mockResolvedValue({default:()=> <p>Imported section</p>});
    const Page=recoverableLazy(importer);
    render(<MemoryRouter><RouteErrorBoundary><Suspense fallback={<p>Loading</p>}><Page/></Suspense></RouteErrorBoundary></MemoryRouter>);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(importer).toHaveBeenCalledOnce();expect(screen.queryByText('private-url')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Load new app version'})).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'Try Again'}));
    expect(await screen.findByText('Imported section')).toBeInTheDocument();expect(importer).toHaveBeenCalledTimes(2);
  });
  it('does not present 403 as a connection failure or invite futile retries', () => {
    render(<QueryError error={{response:{status:403}}} onRetry={vi.fn()}/>);
    expect(screen.getByText('Access restricted')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Try Again'})).not.toBeInTheDocument();
  });
  it('gates a forbidden direct URL before mounting its component', () => {
    vi.mocked(useAuth).mockReturnValueOnce({hasPermission:()=>false} as ReturnType<typeof useAuth>);
    const Page=vi.fn(()=> <p>Private page</p>);
    render(<MemoryRouter initialEntries={['/rate-plans']}><RouteAccess><Page/></RouteAccess></MemoryRouter>);
    expect(screen.getByText('Access restricted')).toBeInTheDocument();expect(Page).not.toHaveBeenCalled();
  });
  it('does not retain a previous property draft or mutation result after switching scope', async()=>{
    scope.propertyId='a';
    function Page(){const [value,setValue]=useState('Empty');return <button onClick={()=>setValue('Property A draft')}>{value}</button>;}
    const ui=<MemoryRouter><RouteAccess><Page/></RouteAccess></MemoryRouter>;
    const {rerender}=render(ui);
    await userEvent.click(screen.getByText('Empty'));expect(screen.getByText('Property A draft')).toBeInTheDocument();
    scope.propertyId='b';rerender(<MemoryRouter><RouteAccess><Page/></RouteAccess></MemoryRouter>);
    expect(screen.getByText('Empty')).toBeInTheDocument();scope.propertyId='a';
  });
  it('recovers a failed section when its property context changes',()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});scope.propertyId='a';
    function Page(){if(scope.propertyId==='a')throw Error('Bad property response');return <p>Healthy property section</p>;}
    const {rerender}=render(<MemoryRouter><RouteErrorBoundary><Page/></RouteErrorBoundary></MemoryRouter>);
    expect(screen.getByRole('alert')).toBeInTheDocument();scope.propertyId='b';
    rerender(<MemoryRouter><RouteErrorBoundary><Page/></RouteErrorBoundary></MemoryRouter>);
    expect(screen.getByText('Healthy property section')).toBeInTheDocument();scope.propertyId='a';
  });
});
