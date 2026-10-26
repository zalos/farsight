// Original synthetic Express 4.21.2 fixtures for the PR 15 pack. None is a real application and none is ever
// installed, built or run here: each is a whole small repository that a test writes into a temporary Git repository,
// captures, parses with the public parser and reads as source.

export const MANIFEST = (express = '4.21.2', extra = '') => `{
  "name": "sentinel-express-fixture",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "express": "${express}"
  }${extra}
}
`;

export const LOCK = (range: string, resolved: string) => `{
  "name": "sentinel-express-fixture",
  "version": "0.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "sentinel-express-fixture",
      "version": "0.0.0",
      "dependencies": {
        "express": "${range}"
      }
    },
    "node_modules/express": {
      "version": "${resolved}",
      "license": "MIT"
    }
  }
}
`;

/** Middleware whose bodies the pack reads: a 401 refusal, a 403 refusal factory, a pass-through, a skipper. */
export const AUTH = `import type { NextFunction, Request, Response } from 'express';

// Synthetic fixture. Never run.
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'sign in first' });
  next();
}

export const requireRole = (role: string) => (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== role) {
    res.sendStatus(403);
    return;
  }
  next();
};

// Named like a control, but it only logs and passes the request on.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  console.log(\`\${req.method} \${req.url}\`);
  next();
}

// Skips the rest of the route for preview requests.
export function maybeSkip(req: Request, res: Response, next: NextFunction) {
  if (req.query.preview) return next('route');
  next();
}
`;

export const SERVER = `import app from './app.js';

app.listen(3000);
`;

const files = (app: string, extra: Record<string, string> = {}, manifest = MANIFEST()) => ({
  'package.json': manifest,
  'src/auth.ts': AUTH,
  'src/server.ts': SERVER,
  'src/app.ts': app,
  ...extra,
});
export { files as expressApp };

/** Registration order: a route before the control, one after it, and a control registered after every route. */
export const ORDER = files(`import express from 'express';
import { requireRole, requireUser } from './auth.js';

const app = express();
app.use(express.json());
app.get('/reports', (req, res) => { res.json([]); });
app.use(requireUser);
app.get('/account', (req, res) => { res.json({}); });
app.post('/account', requireRole('owner'), (req, res) => { res.sendStatus(204); });
// Registered after every route: it never runs before any of them.
app.use(requireRole('admin'));

export default app;
`);

/** Nested routers: /api requires a user, /api/admin also requires the admin role, and an app route below /api. */
export const NESTED = files(
  `import express from 'express';
import api from './routes/api.js';

const app = express();
app.use('/api', api);
// Registered on the application after the mount: requests still pass the api router's own layers first.
app.get('/api/health', (req, res) => { res.json({ ok: true }); });
app.get('/status', (req, res) => { res.json({ ok: true }); });

export default app;
`,
  {
    'src/routes/api.ts': `import { Router } from 'express';
import { requireUser } from '../auth.js';
import admin from './admin.js';

const router = Router();
router.use(requireUser);
router.use('/admin', admin);
router.get('/me', (req, res) => { res.json({}); });

export default router;
`,
    'src/routes/admin.ts': `import express from 'express';
import { requireRole } from '../auth.js';

const router = express.Router();
router.use(requireRole('admin'));
router.get('/stats', (req, res) => { res.json({}); });

export default router;
`,
  },
);
