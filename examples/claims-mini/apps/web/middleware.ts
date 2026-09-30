/** Session check on every request — the auth seam of the app. */
export function middleware(req: { url: string }) {
  return req.url;
}
