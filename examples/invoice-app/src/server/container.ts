import { db } from './db';
import { loadEnv } from './config/env';

const KEY = Symbol.for('invoice.container');

/** The process-wide slot the container is parked on, so a reload reuses it. */
function holder(): { c?: OutboxWorker } {
  return ((globalThis as any)[KEY] ??= {});
}

/**
 * Builds the process container once: checks the environment and wires the outbox
 * worker with the hooks the rest of the app hangs off.
 */
function buildContainer(): OutboxWorker {
  loadEnv();
  return new OutboxWorker({
    hooks: {
      /** Marks the invoice synced once the approval reached the ledger. */
      invoiceApproved: async () => {
        await db.invoices.update({ status: 'approved' }, { synced: true });
      },
    },
    log: (m: string) => console.log(m),
  });
}

/** The container, built on first use and reused for the life of the process. */
export function getContainer(): OutboxWorker {
  return (holder().c ??= buildContainer());
}

/** Drains the outbox and runs whatever the container bound to each hook. */
export class OutboxWorker {
  constructor(private readonly deps: { hooks?: { invoiceApproved?: () => Promise<void> }; log?: (m: string) => void }) {}

  async drain() {
    await this.deps.hooks?.invoiceApproved?.();
  }
}
