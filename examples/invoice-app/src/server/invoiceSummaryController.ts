import { Controller, Get } from '@nestjs/common';

/** A local spelling of Nest's GET decorator. */
const JsonGet = Get;

@Controller('api/invoice-summary')
export class InvoiceSummaryController {
  @JsonGet('ready')
  ready() {
    return { ready: true };
  }
}
