const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DemoResetConfig = {
  propertyId: string;
  execute: boolean;
  expectedConfirmation: string;
};

export function demoResetConfirmation(propertyId: string): string {
  return `RESET:${propertyId}`;
}

export function readDemoResetConfig(
  env: Record<string, string | undefined> = process.env,
): DemoResetConfig {
  const propertyId = env['DEMO_RESET_PROPERTY_ID']?.trim();
  if (!propertyId) {
    throw new Error('DEMO_RESET_PROPERTY_ID is required');
  }
  if (!UUID_PATTERN.test(propertyId)) {
    throw new Error('DEMO_RESET_PROPERTY_ID must be a UUID');
  }

  const expectedConfirmation = demoResetConfirmation(propertyId);
  const suppliedConfirmation = env['DEMO_RESET_CONFIRM']?.trim();
  if (suppliedConfirmation && suppliedConfirmation !== expectedConfirmation) {
    throw new Error(`DEMO_RESET_CONFIRM must equal ${expectedConfirmation}`);
  }

  return {
    propertyId,
    execute: suppliedConfirmation === expectedConfirmation,
    expectedConfirmation,
  };
}
