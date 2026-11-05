import { AdminShell, type ShellEnvironment, type ShellUser } from "@/components/layout/admin-shell";
import type { SidebarGroup } from "@/components/layout/sidebar";
import { navGroups } from "@/config/nav";
import { envReport } from "@/config/env";
import { can } from "@/lib/authz/permissions";
import { requireSession } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

/**
 * Server-side gate for the whole console.
 *
 * `requireSession()` redirects to /login when there is no fully-authenticated
 * (MFA-verified where enrolled) session. The navigation tree is then filtered
 * by the caller's role BEFORE it reaches the client, so a viewer never even
 * receives the href for /users.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { admin } = await requireSession();

  const groups: SidebarGroup[] = navGroups
    .map((group) => ({
      label: group.label,
      items: group.items
        .filter((item) => can(admin.role, item.capability))
        .map((item) => ({
          title: item.title,
          href: item.href,
          icon: item.icon,
          description: item.description,
        })),
    }))
    .filter((group) => group.items.length > 0);

  const user: ShellUser = {
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    role: admin.role,
    mfaEnrolled: admin.mfaEnrolledAt !== null,
    mfaRequired: admin.mfaRequired,
  };

  const report = envReport();
  const environment: ShellEnvironment = {
    authProvider: report.authProvider,
    supabaseConfigured: report.supabase.configured,
    nodeEnv: report.nodeEnv,
    aiOpsLlmActive: report.aiOps.llmActive,
  };

  return (
    <AdminShell groups={groups} user={user} environment={environment}>
      {children}
    </AdminShell>
  );
}
