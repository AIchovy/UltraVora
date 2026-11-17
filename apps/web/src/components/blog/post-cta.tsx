// apps/web/src/components/blog/post-cta.tsx
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Conversion block rendered under every article body. */
export function PostCta(): React.ReactElement {
  return (
    <aside className="mt-12 rounded-2xl border border-border/70 bg-muted/40 p-8 text-center">
      <h2 className="text-xl font-semibold tracking-tight">
        Put this into practice — on your own product
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        UltraVora researches your product, writes the script, records the voiceover, and renders
        the finished promo video. You direct; it does the production.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg" className="active:translate-y-px">
          <Link href="/login">
            Make a free video
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="active:translate-y-px">
          <Link href="/plaza">See examples</Link>
        </Button>
      </div>
    </aside>
  );
}
