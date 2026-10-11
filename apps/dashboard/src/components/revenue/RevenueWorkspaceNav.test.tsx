import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import RevenueWorkspaceNav from './RevenueWorkspaceNav';

const auth=vi.hoisted(()=>({allowed:new Set(['revenue.manage','rateplans.read','reports.view'])}));
vi.mock('../../context/AuthContext',()=>({useAuth:()=>({hasPermission:(key:string)=>auth.allowed.has(key)})}));
vi.mock('../../context/PropertyContext',()=>({useProperty:()=>({propertyId:'property-a'})}));
beforeEach(()=>{auth.allowed=new Set(['revenue.manage','rateplans.read','reports.view']);void i18n.changeLanguage('ru');});
afterEach(()=>i18n.changeLanguage('en'));
describe('revenue navigation context',()=>{
  it('keeps property in every destination and labels simulation and historical occupancy truthfully',()=>{
    render(<MemoryRouter><RevenueWorkspaceNav/></MemoryRouter>);
    for(const link of screen.getAllByRole('link'))expect(link.getAttribute('href')).toContain('propertyId=property-a');
    expect(screen.getByRole('link',{name:'Симуляция цен'})).toHaveAttribute('href','/dynamic-pricing?propertyId=property-a');
    expect(screen.getByRole('link',{name:'Динамика загрузки'})).toHaveAttribute('href','/reports?report=occupancy-trend&propertyId=property-a');
  });
  it('does not highlight both overview and pricing history on the same path',()=>{
    render(<MemoryRouter initialEntries={['/revenue?section=history&propertyId=property-a']}><RevenueWorkspaceNav/></MemoryRouter>);
    expect(screen.getByRole('link',{name:'История изменений'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('link',{name:'Обзор'})).not.toHaveAttribute('aria-current','page');
  });
  it('hides reports and rate management without the corresponding grants',()=>{
    auth.allowed=new Set(['revenue.manage']);render(<MemoryRouter><RevenueWorkspaceNav/></MemoryRouter>);
    expect(screen.queryByRole('link',{name:'Тарифы и ограничения'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'Прирост и темп продаж'})).not.toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Обзор'})).toBeInTheDocument();
  });
});
