// Synthetic Sentinel E2 fixture (next-matcher). Original, inert, never installed outside a bounded
// probe container. Outside the declared matcher entirely, so the middleware never runs for this path.
export default function handler(req, res) {
  res.status(200).json({ reached: 'public-info' });
}
