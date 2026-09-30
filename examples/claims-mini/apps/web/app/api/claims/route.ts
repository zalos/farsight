import { listClaims, intakeClaim, requireContractorSession } from '@claims/domain';
import { z } from 'zod';

const claimIntakeSchema = z.object({ description: z.string() });

function handle<T>(fn: () => T) {
  return fn();
}

export async function GET() {
  return handle(() => {
    requireContractorSession('token');
    return listClaims();
  });
}
export async function POST(body: unknown) {
  return handle(() => {
    requireContractorSession('token');
    const claim = claimIntakeSchema.safeParse(body);
    return intakeClaim(claim);
  });
}
