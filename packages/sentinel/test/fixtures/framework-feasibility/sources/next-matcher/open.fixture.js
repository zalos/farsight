// Synthetic Sentinel E2 fixture (next-matcher). Original, inert, never installed outside a bounded
// probe container. Matched by the middleware matcher but explicitly exempted in the middleware body.
export default function handler(req, res) {
  res.status(200).json({ reached: 'dashboard-open' });
}
