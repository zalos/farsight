import { createBrowserRouter } from 'react-router-dom';
import { InvoicesPage } from './app/invoices-page';

/** The billing web app's screens. */
export const router = createBrowserRouter([
  { path: '/invoices', element: <InvoicesPage /> },
]);
