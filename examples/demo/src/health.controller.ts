import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, NotFoundException, Param } from '@nestjs/common';
import { PublicTenant, TenantClientManager } from '@massimiliano-dev/nestjs-prisma-tenants';

const digest = (value: string) => createHash('sha256').update(value).digest();

@PublicTenant()
@Controller('health')
export class HealthController {
  constructor(@Inject(TenantClientManager) private readonly manager: TenantClientManager<unknown>) {}

  /** Liveness only. Public, reveals nothing about tenants. */
  @Get()
  health() {
    return { status: 'ok' };
  }

  /** Cache and circuit state per tenant. Lists tenant slugs, so it requires ADMIN_TOKEN. */
  @Get('details')
  details(@Headers('x-admin-token') token?: string) {
    this.assertAdmin(token);
    return this.manager.stats();
  }

  @Get('tenants/:slug')
  tenant(@Param('slug') slug: string, @Headers('x-admin-token') token?: string) {
    this.assertAdmin(token);
    return this.manager.ping(slug);
  }

  /** Constant-time comparison. Without ADMIN_TOKEN configured the endpoints do not exist. */
  private assertAdmin(token: string | undefined): void {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || !token || !timingSafeEqual(digest(token), digest(expected)))
      throw new NotFoundException();
  }
}
