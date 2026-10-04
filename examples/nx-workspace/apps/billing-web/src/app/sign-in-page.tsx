import { PageShell } from '@nxw/shared/ui';

/** Signs a billing user in with the email address their invoices go to. */
export function SignInPage() {
  return (
    <PageShell title="Sign in">
      <form>
        <input type="email" name="email" />
      </form>
    </PageShell>
  );
}
