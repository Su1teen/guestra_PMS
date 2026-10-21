import { describe, expect, it } from 'vitest';
import { parseBootstrapCredentials } from './bootstrap-connect.js';
const record = {id:'b0000001-0000-4000-a000-000000000001',propertyId:'a0000001-0000-4000-a000-000000000001',label:'Studio read',key:'a'.repeat(48),environment:'production',scopes:['integration.read']};
describe('declarative Connect credential validation', () => {
  it('accepts explicit property-bound read profiles', () => expect(parseBootstrapCredentials(JSON.stringify([record]),'production')).toHaveLength(1));
  it('rejects platform scopes, environment mismatch, duplicate keys and malformed input without echoing keys', () => {
    for (const bad of [{...record,scopes:['platform']},{...record,environment:'test'},{...record,scopes:['sandbox.setup']}]) {
      expect(() => parseBootstrapCredentials(JSON.stringify([bad]),'production')).toThrow('INVALID_CONNECT_CREDENTIAL_RECORD');
    }
    expect(() => parseBootstrapCredentials(JSON.stringify([record,record]),'production')).toThrow('DUPLICATE_CONNECT_CREDENTIAL');
    expect(() => parseBootstrapCredentials('{raw-key-secret','production')).toThrow('INVALID_CONNECT_CREDENTIALS_JSON');
  });
});
