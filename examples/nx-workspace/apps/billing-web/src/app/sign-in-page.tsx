/** Signs a billing user in with the email address their invoices go to. */
export function SignInPage() {
  return (
    <form>
      <label>
        Email <input type="email" name="email" />
      </label>
    </form>
  );
}
