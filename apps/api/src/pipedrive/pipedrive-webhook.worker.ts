import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { PipedriveWebhookService } from "./pipedrive-webhook.service";

/** PostgreSQL inbox worker. Every API instance may poll; row leases coordinate them. */
@Injectable()
export class PipedriveWebhookWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  constructor(
    @Inject(PipedriveWebhookService)
    private readonly webhooks: PipedriveWebhookService,
  ) {}
  onModuleInit() {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.webhooks.sweep();
    } catch {
      /* Durable inbox survives unavailable DB; no private error logging. */
    } finally {
      this.running = false;
    }
  }
}
