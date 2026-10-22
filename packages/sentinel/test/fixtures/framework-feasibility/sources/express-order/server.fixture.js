// Synthetic Sentinel E2 fixture (express-order). Original, inert, never installed outside a bounded
// probe container. Demonstrates that Express runs middleware and route handlers strictly in the order
// they were registered: a check registered before a route can gate it, a check registered after the
// route that already answered the request cannot, and a check whose active branch is picked once at
// startup from outside the fixture cannot be labelled from source text alone.
'use strict';
const express = require('express');
const app = express();

const TOKEN = 'FIXTURE_CANARY_ONLY';

function requireAuth(req, res, next) {
  if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ blocked: 'requireAuth' });
}

// Called once, at route-registration time during process startup, from an environment switch; a
// static reader cannot see which function this becomes without evaluating SENTINEL_FIXTURE_OPAQUE_MODE
// as it is set when the process starts, matching the "unknown custom middleware" lesson. This is a
// startup-time branch, not a per-request decision: every request to /admin/opaque for the life of this
// process is handled by whichever single function this call returned when the route was registered.
function resolveOpaqueMiddleware() {
  if (process.env.SENTINEL_FIXTURE_OPAQUE_MODE === 'deny') return (req, res) => res.status(403).json({ blocked: 'opaque' });
  return (req, res, next) => next();
}

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// auth-before-route: the gate is registered before the route it guards.
app.use('/admin/early', requireAuth);
app.get('/admin/early', (req, res) => res.status(200).json({ reached: 'early' }));

// auth-after-route: the route is registered first and fully answers the request before this gate is
// ever attached, so it never runs for this path. Registration order, not presence, decides reach.
app.get('/admin/late', (req, res) => res.status(200).json({ reached: 'late' }));
app.use('/admin/late', requireAuth);

// unknown-custom-middleware: the gate function is chosen once at startup, not declared at this call site.
app.get('/admin/opaque', resolveOpaqueMiddleware(), (req, res) => res.status(200).json({ reached: 'opaque' }));

const port = Number(process.env.PORT || 3000);
app.listen(port, '127.0.0.1', () => { process.stdout.write(`fixture-express-order listening on ${port}\n`); });
