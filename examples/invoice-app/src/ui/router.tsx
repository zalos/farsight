import { createBrowserRouter } from 'react-router-dom';
import { InvoiceListPage } from './InvoiceListPage';
import { CreateInvoiceForm } from './CreateInvoiceForm';
import { EditInvoiceDrawer } from './EditInvoiceDrawer';

/** Application routes — every screen a user can land on. */
export const router = createBrowserRouter([
  { path: '/invoices', element: <InvoiceListPage /> },
  { path: '/invoices/new', element: <CreateInvoiceForm onDone={() => history.back()} /> },
  { path: '/invoices/:id/edit', element: <EditInvoiceDrawer invoiceId={''} onClose={() => history.back()} /> },
]);
