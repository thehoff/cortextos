import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getOrgs } from '@/lib/config';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { syncAll } from '@/lib/sync';
import { getAllOrgThemes } from '@/lib/data/organization';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect('/login');

  // Sync filesystem state to SQLite on every page load
  // This ensures the dashboard always reflects the latest agent activity
  try {
    syncAll();
  } catch (e) {
    console.error('Sync failed:', e);
  }

  const orgs = getOrgs();
  // Read every org's theme block server-side and seed it into the shell so
  // org switching is flash-free without an extra HTTP round-trip per switch.
  // Orgs without a theme block are omitted from the map.
  const orgThemes = getAllOrgThemes();

  return <DashboardShell orgs={orgs} orgThemes={orgThemes}>{children}</DashboardShell>;
}
