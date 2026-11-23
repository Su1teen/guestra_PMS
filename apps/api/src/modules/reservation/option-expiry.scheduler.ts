import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ReservationGuaranteeService } from './reservation-guarantee.service';

/**
 * Checks option deadlines every minute so a short hold (for example 90 minutes) frees the room on
 * time instead of waiting for the night audit. Each run handles every property with an expired
 * option; the sweep is idempotent, so overlapping instances do not double-cancel.
 */
@Injectable()
export class OptionExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  static readonly INTERVAL_MS = 60_000;
  private readonly logger = new Logger(OptionExpiryScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly guarantee: ReservationGuaranteeService) {}

  onModuleInit() {
    if (process.env['NODE_ENV'] === 'test' || process.env['OPTION_SWEEP_DISABLED'] === 'true') return;
    this.timer = setInterval(() => { void this.tick(); }, OptionExpiryScheduler.INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.running) return { properties: 0, skipped: true };
    this.running = true;
    try {
      const propertyIds = await this.guarantee.propertiesWithExpiredOptions(now);
      for (const propertyId of propertyIds) {
        try {
          const result = await this.guarantee.sweepExpiredOptions(propertyId, now);
          if (result.cancelled || result.confirmed || result.failed) this.logger.log(`Option sweep ${propertyId}: ${JSON.stringify(result)}`);
        } catch (error) {
          this.logger.warn(`Option sweep for property ${propertyId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { properties: propertyIds.length, skipped: false };
    } catch (error) {
      this.logger.warn(`Option sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return { properties: 0, skipped: false };
    } finally { this.running = false; }
  }
}
