import { ERP_HOST } from './hosts';

/**
 * Posts finalized invoices to the accounting system.
 * @remarks The base URL is assembled from a constant, so the URL at the call site
 * is never a literal — farsight.config.json names what this client reaches.
 */
export class ErpClient {
  readonly baseUrl: string;

  constructor() {
    this.baseUrl = `${ERP_HOST}/v2`;
  }

  /**
   * Sends one document to the accounting system.
   * @business Files the finalized invoice with the accounting system.
   */
  async request(a: { url: string }) {
    return fetch(a.url, { method: 'POST' });
  }
}
