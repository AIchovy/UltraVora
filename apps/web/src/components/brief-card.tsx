"use client";
import type { Brief } from "@ultracreator/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AssetManager } from "./asset-manager";

interface Props {
  sid: string;
  brief: Brief;
  stale?: boolean;
}

export function BriefCard({ sid, brief, stale = false }: Props): React.ReactElement {
  const { product, audience, keyMessages, brandHints, sourceAssets, constraints } = brief;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{product.name}</CardTitle>
          {stale && <Badge variant="destructive">stale</Badge>}
        </div>
        <CardDescription>{product.tagline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{product.description}</p>

        <Section title="Audience">
          <p className="text-sm">{audience}</p>
        </Section>

        <Section title="Key messages">
          <ul className="grid gap-1.5 text-sm">
            {keyMessages.map((m) => (
              <li key={m} className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                {m}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Brand">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              {brandHints.colors.map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <span
                    data-testid={`swatch-${c}`}
                    title={c}
                    className="h-7 w-7 rounded-lg shadow-xs ring-1 ring-inset ring-black/[0.06]"
                    style={{ backgroundColor: c }}
                  />
                  <span className="font-mono text-xs text-muted-foreground">{c}</span>
                </div>
              ))}
            </div>
            {/* Editable: the research gate is where the user curates captured
                assets before design derives keyVisuals from them. */}
            <AssetManager sid={sid} logoFile={brandHints.logoFile} images={sourceAssets.images} />
          </div>
        </Section>

        <Section title="Constraints">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{constraints.durationSec}s</Badge>
            <Badge variant="secondary">{constraints.aspectRatio}</Badge>
            {constraints.withVoiceover && <Badge>voiceover</Badge>}
          </div>
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}
