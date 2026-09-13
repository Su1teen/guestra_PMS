import { describe, expect, it } from 'vitest';
import {
  demoResetConfirmation,
  readDemoResetConfig,
} from './reset-demo-property.config.js';

const PROPERTY_ID = 'a0000001-0000-4000-a000-000000000001';

describe('demo property reset configuration', () => {
  it('requires an explicit property UUID', () => {
    expect(() => readDemoResetConfig({})).toThrow('DEMO_RESET_PROPERTY_ID is required');
    expect(() => readDemoResetConfig({ DEMO_RESET_PROPERTY_ID: 'not-an-id' }))
      .toThrow('DEMO_RESET_PROPERTY_ID must be a UUID');
  });

  it('defaults to preview mode when confirmation is omitted', () => {
    expect(readDemoResetConfig({ DEMO_RESET_PROPERTY_ID: PROPERTY_ID })).toEqual({
      propertyId: PROPERTY_ID,
      execute: false,
      expectedConfirmation: demoResetConfirmation(PROPERTY_ID),
    });
  });

  it('executes only with the exact property-bound confirmation', () => {
    const expectedConfirmation = demoResetConfirmation(PROPERTY_ID);
    expect(readDemoResetConfig({
      DEMO_RESET_PROPERTY_ID: PROPERTY_ID,
      DEMO_RESET_CONFIRM: expectedConfirmation,
    }).execute).toBe(true);

    expect(() => readDemoResetConfig({
      DEMO_RESET_PROPERTY_ID: PROPERTY_ID,
      DEMO_RESET_CONFIRM: 'RESET:another-property',
    })).toThrow(`DEMO_RESET_CONFIRM must equal ${expectedConfirmation}`);
  });
});
