import { ECHO_RUNTIME_STRINGS } from '@farsight/core/dist/strings-echo-runtime.js';
export function word(key: string, values: Record<string, string | number> = {}): string {
  let text = ECHO_RUNTIME_STRINGS[`echo.runtime.${key}`]?.professional ?? key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
