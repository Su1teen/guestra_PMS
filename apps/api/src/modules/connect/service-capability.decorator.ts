import { SetMetadata } from '@nestjs/common';
export const CONNECT_SERVICE_CAPABILITY = 'connect_service_capability';
export const ServiceCapability = (scope: 'services.read' | 'services.write' | 'integration.read' | 'integration.write' | 'events.read' | 'sandbox.setup') => SetMetadata(CONNECT_SERVICE_CAPABILITY, scope);
