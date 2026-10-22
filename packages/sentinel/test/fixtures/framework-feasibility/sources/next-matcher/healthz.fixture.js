// Synthetic Sentinel E2 fixture (next-matcher). Original, inert. Readiness probe only; outside the
// matcher under test.
export default function handler(req, res) {
  res.status(200).json({ ok: true });
}
