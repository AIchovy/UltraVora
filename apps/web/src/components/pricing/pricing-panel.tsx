"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import {
  PLAN_LIST,
  CREDIT_PACKS,
  CUSTOM_CREDIT_BOUNDS,
  CREDITS_PER_USD,
  yearlyUsd,
  type Plan,
  type PlanTier,
} from "@ultracreator/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CreditMark } from "@/components/credit-mark";
import { cn } from "@/lib/utils";

export type PurchaseIntent =
  | { kind: "subscription"; tier: PlanTier; interval: "monthly" | "yearly" }
  | { kind: "credits"; usd: number };

interface PricingPanelProps {
  /** "app": real purchase via onPurchase. "marketing": onPurchase routes to /login. */
  mode: "app" | "marketing";
  /** The user's current tier (highlights the active plan, labels its button). */
  currentTier?: PlanTier;
  onPurchase: (intent: PurchaseIntent) => void;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

export function PricingPanel({ mode, currentTier, onPurchase }: PricingPanelProps): React.ReactElement {
  const [tab, setTab] = useState<"plans" | "credits">("plans");
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" className="flex items-center gap-1 self-center rounded-lg bg-muted p-1">
        {(["plans", "credits"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors",
              tab === t ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "plans" ? (
        <PlansTab
          mode={mode}
          interval={interval}
          setInterval={setInterval}
          currentTier={currentTier}
          onPurchase={onPurchase}
        />
      ) : (
        <CreditsTab onPurchase={onPurchase} />
      )}
    </div>
  );
}

function PlansTab(props: {
  mode: "app" | "marketing";
  interval: "monthly" | "yearly";
  setInterval: (i: "monthly" | "yearly") => void;
  currentTier?: PlanTier;
  onPurchase: (i: PurchaseIntent) => void;
}): React.ReactElement {
  const { mode, interval, setInterval, currentTier, onPurchase } = props;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {PLAN_LIST.map((plan) => (
        <PlanCard
          key={plan.tier}
          plan={plan}
          interval={interval}
          setInterval={setInterval}
          mode={mode}
          isCurrent={plan.tier === currentTier}
          onPurchase={onPurchase}
        />
      ))}
    </div>
  );
}

/**
 * Per-card monthly/yearly switch. Every card reads and writes the one shared
 * `interval` state, so flipping any paid card's switch re-prices all of them in
 * sync (the cards are "linked").
 */
function BillingSwitch(props: {
  interval: "monthly" | "yearly";
  setInterval: (i: "monthly" | "yearly") => void;
}): React.ReactElement {
  const { interval, setInterval } = props;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          "font-medium whitespace-nowrap transition-colors",
          interval === "monthly" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        Monthly
      </span>
      <Switch
        aria-label="Yearly billing"
        checked={interval === "yearly"}
        onCheckedChange={(on) => setInterval(on ? "yearly" : "monthly")}
      />
      <span
        className={cn(
          "font-medium whitespace-nowrap transition-colors",
          interval === "yearly" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        Yearly
      </span>
    </div>
  );
}

function PlanCard(props: {
  plan: Plan;
  interval: "monthly" | "yearly";
  setInterval: (i: "monthly" | "yearly") => void;
  mode: "app" | "marketing";
  isCurrent: boolean;
  onPurchase: (i: PurchaseIntent) => void;
}): React.ReactElement {
  const { plan, interval, setInterval, mode, isCurrent, onPurchase } = props;
  const perMonth = interval === "monthly" ? plan.monthlyUsd : Math.round(yearlyUsd(plan.monthlyUsd) / 12);
  const credits = plan.monthlyCredits || plan.signupBonus;
  const isFree = plan.tier === "free";

  const label = mode === "marketing"
    ? "Get started"
    : isCurrent
      ? "Current plan"
      : isFree
        ? "Free plan"
        : "Subscribe";

  return (
    <div
      data-testid={`plan-card-${plan.tier}`}
      className={cn(
        "flex flex-col rounded-xl border p-5",
        isCurrent ? "border-primary" : "border-border",
      )}
    >
      {/* Billing switch sits at the top of each paid card; the three are linked.
          Free has no billing period, so it reserves the same height to keep every
          plan name on the same line. */}
      <div className="mb-4 flex h-6 items-center">
        {isFree ? null : <BillingSwitch interval={interval} setInterval={setInterval} />}
      </div>

      <div className="text-sm font-semibold uppercase tracking-wide">{plan.name}</div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-3xl font-bold">${perMonth}</span>
        <span className="text-sm text-muted-foreground">/mo</span>
      </div>
      {isFree ? (
        <div className="mt-0.5 text-xs text-transparent">.</div>
      ) : interval === "yearly" ? (
        <div className="mt-0.5 text-xs text-muted-foreground">
          ${fmt(yearlyUsd(plan.monthlyUsd))}/year, billed yearly
        </div>
      ) : (
        <div className="mt-0.5 text-xs text-muted-foreground">Save 20%, billed yearly</div>
      )}

      <Button
        type="button"
        variant={isFree || isCurrent ? "secondary" : "default"}
        disabled={isCurrent || (isFree && mode === "app")}
        className="mt-4"
        onClick={() => onPurchase({ kind: "subscription", tier: plan.tier, interval })}
      >
        {label}
      </Button>

      <ul className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-primary" />
          {isFree ? `${fmt(credits)} bonus credits` : `${fmt(credits)} credits / month`}
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-primary" />
          {isFree ? "≈ half a 1-min video to try" : `≈ ${Math.round(credits / 400)} one-minute videos / month`}
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-4 w-4 text-primary" />
          {isFree ? "Full resolution, no watermark" : "Top up anytime · commercial use"}
        </li>
      </ul>
    </div>
  );
}

function CreditsTab({ onPurchase }: { onPurchase: (i: PurchaseIntent) => void }): React.ReactElement {
  const [custom, setCustom] = useState("");
  const customUsd = Number(custom);
  const customValid =
    Number.isFinite(customUsd) &&
    customUsd >= CUSTOM_CREDIT_BOUNDS.minUsd &&
    customUsd <= CUSTOM_CREDIT_BOUNDS.maxUsd;

  return (
    // Plans needs the full modal width for 4 columns; the credit list reads better
    // narrow, so center it rather than stretching rows across the whole dialog.
    <div className="mx-auto flex w-full max-w-md flex-col gap-3">
      <p className="text-center text-sm text-muted-foreground">
        1 USD = {CREDITS_PER_USD} credits · purchased credits never expire
      </p>
      {CREDIT_PACKS.map((pack) => (
        <button
          key={pack.usd}
          type="button"
          data-testid={`pack-${pack.usd}`}
          onClick={() => onPurchase({ kind: "credits", usd: pack.usd })}
          className="flex cursor-pointer items-center justify-between rounded-xl border border-border px-5 py-4 text-left transition-colors hover:border-primary"
        >
          <span className="flex items-center gap-2 text-lg font-semibold text-primary">
            <CreditMark className="size-4" />
            <span>{fmt(pack.credits)}</span>
          </span>
          <span className="text-base font-medium">${pack.usd}</span>
        </button>
      ))}
      <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          type="number"
          inputMode="numeric"
          min={CUSTOM_CREDIT_BOUNDS.minUsd}
          max={CUSTOM_CREDIT_BOUNDS.maxUsd}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={`Custom amount (${CUSTOM_CREDIT_BOUNDS.minUsd}–${CUSTOM_CREDIT_BOUNDS.maxUsd})`}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {customValid ? (
          <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
            <CreditMark className="size-3.5" />
            {fmt(customUsd * CREDITS_PER_USD)}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!customValid}
          onClick={() => onPurchase({ kind: "credits", usd: customUsd })}
        >
          Buy
        </Button>
      </div>
    </div>
  );
}
