import { describe, expect, it } from 'vitest';
import { compactParty, defaultDeposit, optionState, partyComplete, statusTone } from './booking';

describe('booking presentation helpers', () => {
  it('maps every status to one tone', () => {
    expect(statusTone('pending')).toBe('tentative');
    expect(statusTone('confirmed')).toBe('confirmed');
    expect(statusTone('assigned')).toBe('confirmed');
    expect(statusTone('stayover')).toBe('inhouse');
    expect(statusTone('due_out')).toBe('departing');
    expect(statusTone('checked_out')).toBe('closed');
  });

  it('labels the party compactly', () => {
    expect(compactParty(2, 0)).toBe('2');
    expect(compactParty(2, 2, [4, 9])).toBe('2 + 2 (4, 9)');
  });

  it('classifies the option deadline', () => {
    const now = Date.parse('2027-01-10T10:00:00Z');
    expect(optionState(null, now)).toBe('none');
    expect(optionState('2027-01-10T09:00:00Z', now)).toBe('expired');
    expect(optionState('2027-01-10T20:00:00Z', now)).toBe('soon');
    expect(optionState('2027-01-15T10:00:00Z', now)).toBe('ok');
  });

  it('derives the default guarantee from the policy', () => {
    const policy = { childAgeBands: [], childAgeBandsConfigured: false, optionHoldHours: 48, optionExpiryAction: null, depositPercentage: 30, autoSendConfirmation: true };
    expect(defaultDeposit(policy, '100000.00')).toBe('30000.00');
    expect(defaultDeposit({ ...policy, depositPercentage: null }, '100000.00')).toBe('');
  });

  it('requires an age for every child', () => {
    expect(partyComplete({ adults: 2, children: 2, childAges: [3] })).toBe(false);
    expect(partyComplete({ adults: 2, children: 2, childAges: [3, 8] })).toBe(true);
    expect(partyComplete({ adults: 2, children: 0, childAges: [] })).toBe(true);
  });
});
