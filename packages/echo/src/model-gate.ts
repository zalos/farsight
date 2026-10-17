/** One generation owner in this Echo process; independent CLI/server processes have separate gates. */
let active = false;

export class ModelBusyError extends Error {
  constructor() { super('busy'); }
}

/** Hold ownership until the actual operation settles, even when its caller has already disconnected. */
export async function withModelOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (active) throw new ModelBusyError();
  active = true;
  try { return await operation(); }
  finally { active = false; }
}
