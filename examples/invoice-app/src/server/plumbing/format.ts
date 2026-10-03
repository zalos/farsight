import { format } from 'date-fns';

/**
 * Formats a timestamp the way the finance team reads it (local date, minutes).
 * @business Shows when the approval happened, in the format the finance team reads.
 * @remarks Declared plumbing in farsight.config.json — presentation only, never a
 * step of its own on a journey however it is annotated.
 */
export function fmt(at: Date): string {
  return format(at, 'yyyy-MM-dd HH:mm');
}
