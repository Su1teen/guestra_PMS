import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Credential administration must never inherit the staff demo bypass. */
@Injectable()
export class CredentialAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (this.config.get('AUTH_ENABLED', 'true') === 'false' || !request.user) {
      throw new UnauthorizedException('STAFF_AUTH_REQUIRED_FOR_CREDENTIAL_MANAGEMENT');
    }
    return true;
  }
}
