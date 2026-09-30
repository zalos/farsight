import DocumentIntelligence from '@azure-rest/ai-document-intelligence';

/** Reads the amounts off a scanned invoice. */
export interface Ocr {
  extract(file: unknown): unknown;
}

/** Production OCR: Azure Document Intelligence. */
export class AzureOcr implements Ocr {
  extract(file: unknown) {
    return DocumentIntelligence(file);
  }
}

/** The stand-in the unit tests hand in — it reads nothing. */
export class MockOcr implements Ocr {
  extract(_file: unknown) {
    return null;
  }
}

/**
 * Reads an uploaded invoice through whichever provider was handed in.
 * @business Pulls the amounts off a scanned invoice so the draft starts filled in.
 */
export function readInvoice(args: { provider: Ocr }) {
  return args.provider.extract(1);
}
