import type { Request, Response, NextFunction } from 'express';

/**
 * Scope-based authorization middleware. Rejects with 403 when the caller's
 * token lacks the required scope.
 * @business Checks the caller is allowed to perform this billing action
 * before the request reaches the handler.
 * @remarks Applied per-route in {@link router}; admin actions require billing:admin.
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes: string[] = (req as any).auth?.scopes ?? [];
    if (!scopes.includes(scope)) {
      res.status(403).json({ error: `missing scope ${scope}` });
      return;
    }
    next();
  };
}
