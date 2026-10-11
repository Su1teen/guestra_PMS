import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/helpers';
import { api } from '../lib/api';
import Operations from './Operations';
const access = vi.hoisted(() => ({ manage: true }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => access.manage }) }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT' }) }));
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); access.manage = true;
  window.history.replaceState({}, '', '/operations?tab=tasks&action=create-task&reservationId=stay-a&propertyId=hotel-a');
  vi.mocked(api.get).mockResolvedValue({ data: [] });
  vi.mocked(api.post).mockResolvedValue({ data: { id: 'task-a' } });
});
it('uses the existing task form with the reservation context and consumes the action once', async () => {
  renderWithProviders(<Operations/>);
  await screen.findByRole('dialog', { name: 'New request / task' });
  expect(new URLSearchParams(window.location.search).get('action')).toBeNull();
  expect(new URLSearchParams(window.location.search).get('reservationId')).toBe('stay-a');
  await userEvent.type(screen.getByPlaceholderText('What needs to be done?'), 'Prepare cot');
  await userEvent.type(screen.getByPlaceholderText('Description and context'), 'Guest request');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/service-requests', expect.objectContaining({ propertyId: 'hotel-a', reservationId: 'stay-a', title: 'Prepare cot' })));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('does not open a task editor or show creation controls without ops.manage', async () => {
  access.manage = false; renderWithProviders(<Operations/>);
  await screen.findByText('Operations');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Task' })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});
