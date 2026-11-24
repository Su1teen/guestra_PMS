import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RemotePaymentService } from './remote-payment.service';

/**
 * Every minute re-reads open Kaspi invoices, so a lost webhook never leaves a paid prepayment
 * unrecorded, and withdraws invoices whose stay no longer waits for the money.
 */
@Injectable()
export class RemotePaymentScheduler implements OnModuleInit, OnModuleDestroy {
  static readonly INTERVAL_MS = 60_000;
  private readonly logger = new Logger(RemotePaymentScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly remotePayments: RemotePaymentService) {}

  onModuleInit() {
    if (process.env['NODE_ENV'] === 'test' || process.env['REMOTE_PAYMENT_SWEEP_DISABLED'] === 'true') return;
    this.timer = setInterval(() => { void this.tick(); }, RemotePaymentScheduler.INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.running) return { checked: 0, skipped: true };
    this.running = true;
    try {
      const result = await this.remotePayments.sweep(now);
      if (result.checked) this.logger.log(`Remote payment sweep: ${result.checked} checked`);
      return { ...result, skipped: false };
    } catch (error) {
      this.logger.warn(`Remote payment sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return { checked: 0, skipped: false };
    } finally { this.running = false; }
  }
}
