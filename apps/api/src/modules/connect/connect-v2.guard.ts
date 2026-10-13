import { Injectable, Inject, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CONNECT_SERVICE_CAPABILITY } from './service-capability.decorator';
import {DRIZZLE} from '../../database/database.module';
import {integrationDeployment} from './connect-operation-schema';
import {createHmac,timingSafeEqual} from 'node:crypto';
@Injectable()
export class ConnectV2Guard implements CanActivate {
  constructor(private readonly config:ConfigService,@Inject(DRIZZLE) private readonly db:any) {}
  async canActivate(context:ExecutionContext) {
    if(this.config.get('GUESTRA_INTEGRATION_V2_ENABLED')!=='true') throw new ForbiddenException('INTEGRATION_DISABLED');
    const request=context.switchToHttp().getRequest();
    const principal=request.connect;
    const scope=Reflect.getMetadata(CONNECT_SERVICE_CAPABILITY,context.getHandler()) as string;
    if(!principal || principal.scope!=='property' || !scope || !principal.scopes?.includes(scope))
      throw new ForbiddenException('V2_REQUIRES_SCOPED_PRINCIPAL');
    const property=request.body?.propertyId??request.query?.propertyId;
    if(typeof property!=='string'||property!==principal.propertyId)throw new ForbiddenException('PROPERTY_SCOPE_REQUIRED');
    const environment=this.config.get('INTEGRATION_ENVIRONMENT','production');
    if(!['test','sandbox','production'].includes(environment)||!principal.scopes.includes('environment:'+environment))
      throw new ForbiddenException('ENVIRONMENT_NOT_CONFIGURED');
    let deployment:any;
    try {[deployment]=await this.db.select().from(integrationDeployment).limit(1);}catch {throw new ForbiddenException('INTEGRATION_DATABASE_NOT_ATTESTED');}
    if(!deployment||deployment.environment!==environment)throw new ForbiddenException('INTEGRATION_DATABASE_NOT_ATTESTED');
    if(scope==='integration.write') {
      const secret=this.config.get('PMS_COMMAND_SECRET',''),timestamp=request.headers['x-guestra-command-time'],signature=request.headers['x-guestra-command-signature'];
      if(secret.length<32||typeof timestamp!=='string'||!/^\d+$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||typeof signature!=='string')
        throw new ForbiddenException('TRUSTED_CRM_COMMAND_REQUIRED');
      const expected=createHmac('sha256',secret).update(timestamp+'.'+request.method+'.'+request.path+'.'+JSON.stringify(request.body)).digest();
      const provided=Buffer.from(signature,'hex');
      if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw new ForbiddenException('TRUSTED_CRM_COMMAND_REQUIRED');
    }
    return true;
  }
}
