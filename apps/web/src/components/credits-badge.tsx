"use client";
import { useState } from "react";
import { Sparkles, Coins, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { getPlan } from "@ultracreator/shared";
import { CreditMark } from "./credit-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCredits } from "@/state/use-credits";
import { createPortalSession, ApiError } from "@/lib/api-client";
import { PricingDialog } from "./pricing/pricing-dialog";

/**
 * Top-right credits widget: shows the balance as a pill; the dropdown shows the
 * balance + subscription status plus the purchase entries (Upgrade / Buy
 * credits open the pricing modal; Manage subscription opens the Creem portal).
 */
export function CreditsBadge(): React.ReactElement {
  const { data } = useCredits();
  const [open, setOpen] = useState(false);
  const balance = data?.balance ?? 0;
  const tier = data?.subscription?.tier ?? "free";
  const plan = getPlan(tier);

  const bd = data?.breakdown ?? { subscription: 0, bonus: 0, purchased: 0 };
  const fmt = (n: number): string => n.toLocaleString("en-US");
  const rows = [
    { key: "subscription", label: "Subscription", amount: bd.subscription, note: "resets monthly" },
    { key: "bonus", label: "Bonus", amount: bd.bonus, note: "never expires" },
    { key: "purchased", label: "Purchased", amount: bd.purchased, note: "never expires" },
  ].filter((r) => r.amount > 0);

  const openPricing = () => setOpen(true);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Credits and plan"
            className="cursor-pointer flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1.5 text-sm transition-colors hover:bg-card"
          >
            <CreditMark className="size-3.5 text-primary" />
            <span className="font-medium tabular-nums">{balance.toLocaleString("en-US")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-2">
            <div className="text-xs text-muted-foreground">Credit balance</div>
            <div className="flex items-center gap-1.5">
              <CreditMark className="size-5 text-primary" />
              <span className="text-2xl font-semibold tabular-nums">
                {balance.toLocaleString("en-US")}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{plan.name} plan</div>
          </div>
          {rows.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <div className="flex flex-col gap-1.5 px-2 py-1.5">
                {rows.map((r) => (
                  <div key={r.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {r.label} <span className="text-muted-foreground/60">· {r.note}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums">
                      <CreditMark className="size-3" />
                      {fmt(r.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <DropdownMenuSeparator />
          {/* Upgrade is the premium action — gold icon + "gold foil" label: a
              gradient clipped to the text with a bright band scrolling across
              on a slow loop (see .upgrade-shine in globals.css). */}
          <DropdownMenuItem
            className="focus:bg-[#FBF4DD]"
            onSelect={(e) => {
              e.preventDefault();
              openPricing();
            }}
          >
            <Sparkles className="text-[#C9A227]" />
            <span className="upgrade-shine font-medium">Upgrade plan</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              openPricing();
            }}
          >
            <Coins />
            Buy credits
          </DropdownMenuItem>
          {data?.subscription && data.subscription.status !== "canceled" && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void createPortalSession()
                  .then(({ url }) => window.location.assign(url))
                  .catch((err: unknown) => {
                    toast.error(
                      err instanceof ApiError && err.status === 404
                        ? "No billing portal for this subscription."
                        : "Could not open the billing portal. Please try again.",
                    );
                  });
              }}
            >
              <Settings2 />
              Manage subscription
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <PricingDialog open={open} onOpenChange={setOpen} mode="app" currentTier={tier} />
    </>
  );
}
