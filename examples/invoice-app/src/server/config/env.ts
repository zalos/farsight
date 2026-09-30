import { z } from 'zod';

/**
 * The process environment this service needs. Checked once when the container is
 * built — it gates the boot, never a person's request.
 */
export const appEnvSchema = z.object({ DATABASE_URL: z.string() });

/** Reads and checks the process environment; throws at start-up when a variable is missing. */
export function loadEnv() {
  return appEnvSchema.parse(process.env);
}
