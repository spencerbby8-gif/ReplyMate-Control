import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { can } from "@/lib/authz/permissions";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const session = await getSession({ requireMfa: true });
  if (!session) redirect("/login");
  if (!can(session.admin.role, "dashboard:view")) redirect("/privacy");
  redirect("/dashboard");
}
