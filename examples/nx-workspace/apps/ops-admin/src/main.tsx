import { createBrowserRouter } from 'react-router-dom';
import { formatMoney } from '@nxw/shared/util';
import { PageShell } from '@nxw/shared/ui';

/** The overnight run: how much was collected today. */
export function RunReport({ collected }: { collected: number }) {
  return <PageShell title="Overnight run">Collected {formatMoney(collected)}</PageShell>;
}

/** Signs an operations user in through the company directory. */
export function DirectorySignIn() {
  return <PageShell title="Sign in with the directory">Continue with the directory</PageShell>;
}

/** The operations console's screens. */
export const router = createBrowserRouter([
  { path: '/sign-in/directory', element: <DirectorySignIn /> },
  { path: '/runs', element: <RunReport collected={0} /> },
]);
