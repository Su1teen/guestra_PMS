import { Controller, Get, Inject, Query, Req, UseGuards, ForbiddenException, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { properties } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { integrationDeployment, connectOperations } from './connect-operation-schema';

@ApiTags('Guestra integration readiness')
@ApiSecurity('api-key')
@Controller('connect/diagnostics')
@Public()
@UseGuards(ApiKeyGuard, ConnectScopeGuard)
export class ConnectReadinessController {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService) {}
  @Get()
  @ApiOperation({ summary: 'Read-only integration diagnosis with a property-scoped read credential' })
  @ApiQuery({ name: 'propertyId', required: true })
  async readiness(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Req() request: any) {
    const p = request.connect, environment = this.config.get('INTEGRATION_ENVIRONMENT', 'production');
    if (p?.scope !== 'property' || p.propertyId !== propertyId || !p.scopes?.includes('integration.read')
      || !p.scopes.includes('environment:' + environment)) throw new ForbiddenException('INVALID_SCOPE');
    const statuses: string[] = [];
    try {
      const [property] = await this.db.select({ id: properties.id }).from(properties).where(eq(properties.id, propertyId));
      if (!property) return { statuses: ['TENANT_MISMATCH'], ready: false };
      await this.db.select({ key: connectOperations.key }).from(connectOperations).limit(0);
      const [deployment] = await this.db.select().from(integrationDeployment).limit(1);
      statuses.push('DATABASE_READY');
      if (!deployment || deployment.environment !== environment) statuses.push('DATABASE_NOT_ATTESTED');
      else if (this.config.get('GUESTRA_INTEGRATION_V2_ENABLED') === 'true') statuses.push('PMS_V2_READY');
      else statuses.push('INTEGRATION_DISABLED');
      const mappings = JSON.parse(this.config.get('CRM_PROPERTY_MAPPINGS', '[]'));
      if (!mappings.some((m: any) => m.pmsPropertyId === propertyId && m.environment === environment)) statuses.push('PROPERTY_MAPPING_MISSING');
    } catch (error: any) { statuses.push(error?.code === '42P01' || error?.cause?.code === '42P01' ? 'MIGRATION_REQUIRED' : 'DATABASE_NOT_ATTESTED'); }
    if (this.config.get('GUESTRA_BUSINESS_WRITES_ENABLED') !== 'true') statuses.push('BUSINESS_WRITES_DISABLED');
    return { statuses, ready: statuses.includes('PMS_V2_READY') && !statuses.includes('PROPERTY_MAPPING_MISSING') };
  }
}
