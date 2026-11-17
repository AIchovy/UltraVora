"use client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { type PlanTier } from "@ultracreator/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { createCheckout, ApiError, type CheckoutIntent } from "@/lib/api-client";
import { useRefreshCredits } from "@/state/use-credits";
import { PricingPanel, type PurchaseIntent } from "./pricing-panel";

interface PricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "app": purchases hit the dev grant endpoint. "marketing": routes to /login. */
  mode?: "app" | "marketing";
  currentTier?: PlanTier;
  /** Optional banner (e.g. "You're out of credits.") shown above the plans. */
  notice?: string;
}

/**
 * The pricing modal (Plans + Credits tabs). In "app" mode a purchase creates a
 * Creem checkout and redirects the tab to it; the BILLING_STUBS dev fallback
 * applies the purchase directly (url:null + balance) and stays in-app.
 */
export function PricingDialog({
  open,
  onOpenChange,
  mode = "app",
  currentTier,
  notice,
}: PricingDialogProps): React.ReactElement {
  const router = useRouter();
  const refresh = useRefreshCredits();

  async function onPurchase(intent: PurchaseIntent): Promise<void> {
    if (mode === "marketing") {
      router.push("/login");
      return;
    }
    // Free is the baseline tier — nothing to purchase.
    if (intent.kind === "subscription" && intent.tier === "free") {
      onOpenChange(false);
      return;
    }
    try {
      const out = await createCheckout(intent as CheckoutIntent);
      if (out.url) {
        // Real billing: hand the tab to Creem's checkout page.
        window.location.assign(out.url);
        return;
      }
      // Dev stub fallback applied the purchase directly.
      refresh();
      toast.success(`Purchase applied — balance ${(out.balance ?? 0).toLocaleString("en-US")}`);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("You already have an active subscription — use Manage subscription to change plans.");
        return;
      }
      toast.error("Something went wrong. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent ships with sm:max-w-lg (512px); that survives tailwind-merge as a
          separate responsive group, so a plain max-w-* is ignored at ≥640px. Widen per
          breakpoint, keeping each fixed width below its viewport so it never overflows:
          lg(≥1024)→896, xl(≥1280)→1152, 2xl(≥1536)→1280. */}
      <DialogContent className="lg:max-w-4xl xl:max-w-6xl 2xl:max-w-7xl">
        <DialogHeader>
          <DialogTitle>Plans & credits</DialogTitle>
          <DialogDescription>
            Subscribe for monthly credits, or top up anytime. 1 USD = 100 credits.
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
          >
            {notice}
          </div>
        )}
        <PricingPanel mode={mode} currentTier={currentTier} onPurchase={(i) => void onPurchase(i)} />
      </DialogContent>
    </Dialog>
  );
}
