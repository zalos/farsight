import { createBrowserRouter } from 'react-router-dom';
import { InvoicesPage } from './app/invoices-page';
import { SignInPage } from './app/sign-in-page';

/** The billing web app's screens. */
export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/invoices', element: <InvoicesPage /> },
]);
