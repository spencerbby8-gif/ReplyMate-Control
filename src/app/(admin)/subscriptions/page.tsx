import type { Metadata } from "next";
import { Check, CreditCard, Minus } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireCapability } from "@/lib/authz/guard";
import { formatDateTime } from "@/lib/utils";
import { listPlans, listSubscriptions, subscriptionStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage() {
  await requireCapability("subscriptions:view");
  const [plans, subscriptions, stats] = await Promise.all([listPlans(), listSubscriptions(), subscriptionStats()]);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Plan catalogue and entitlement state. ReplyMate is a personal, BYOK product: there is no billing provider connected and no payment has ever been taken, so subscription records do not exist yet."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{plans.length} plans defined</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} subscriptions</Badge>
            <Badge variant="muted" className="font-mono text-[11px]">no billing provider</Badge>
          </>
        }
      />

      <Alert variant="warning">
        <CreditCard aria-hidden />
        <AlertTitle>Billing is deliberately not wired</AlertTitle>
        <AlertDescription>
          <p>
            The Supabase foundation phase explicitly deferred Paystack, premium and payments
            (<span className="font-mono">docs/supabase/README.md</span>, &ldquo;Deliberately NOT done
            this phase&rdquo;). This page therefore shows the plan catalogue as configuration and
            reports an empty subscription table. No test-mode gateway, no mocked checkout and no
            synthetic subscribers.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Plans defined" value={plans.length} hint="Catalogue configuration" icon={CreditCard} tone={plans.length === 0 ? "muted" : "neutral"} />
        <StatCard label="Active plans" value={plans.filter((p) => p.active).length} hint="Available to grant" icon={CreditCard} tone="positive" />
        <StatCard label="Subscriptions" value={stats.total} hint="Entitlement records" icon={CreditCard} tone={stats.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Revenue recorded" value="—" hint="No billing provider is connected" icon={Minus} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan catalogue</CardTitle>
          <CardDescription>Feature sets derived from the SPEC MoSCoW list. Prices are zero until a billing phase is approved.</CardDescription>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No plans defined"
              reason="Plans are seeded by the bootstrap script from the SPEC feature list. This environment has not run it yet."
              nextStep="Run `npx tsx scripts/bootstrap.ts` to load the reference plan catalogue."
              tone="waiting"
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {plans.map((plan) => (
                <div key={plan.id} className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-muted-foreground">{plan.key}</p>
                      <p className="mt-0.5 text-base font-semibold">{plan.name}</p>
                    </div>
                    <StatusBadge value={plan.active ? "active" : "off"} />
                  </div>
                  <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">
                    {plan.priceMinor === 0 ? "Free" : `${(plan.priceMinor / 100).toFixed(2)} ${plan.currency}`}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">/{plan.interval}</span>
                  </p>
                  <ul className="mt-4 space-y-1.5">
                    {(Array.isArray(plan.features) ? (plan.features as string[]) : []).map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 border-t pt-3 text-[11px] text-muted-foreground">
                    Updated {formatDateTime(plan.updatedAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entitlements</CardTitle>
          <CardDescription>Subscriptions reference an opaque end-user id — never an email address or a contact.</CardDescription>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No subscriptions exist"
              reason="Every ReplyMate user is on the free tier today because no billing provider is connected and no plan has been granted. The table is empty because nothing has happened, and it will stay empty until a payments phase is approved and implemented."
              nextStep="Connecting a provider (Paystack is named in the app docs) requires an owner-approved phase and a change-control entry in docs/BLUEPRINT.md §11."
              tone="blocked"
            />
          ) : (
            <ul className="divide-y">
              {subscriptions.map((subscription) => (
                <li key={subscription.id} className="flex items-center gap-3 py-2.5">
                  <span className="font-mono text-[11px] text-muted-foreground">{subscription.endUserId.slice(0, 8)}…</span>
                  <span className="font-mono text-[11px]">{subscription.planKey}</span>
                  <StatusBadge value={subscription.status} />
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {subscription.currentPeriodEnd ? `until ${formatDateTime(subscription.currentPeriodEnd)}` : "no period"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
