"use client";
import { useState } from "react";
import { motion } from "motion/react";
import type { Design } from "@ultracreator/shared";
import { fileUrl } from "@/lib/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props {
  design: Design;
  /** Session id — needed to resolve workspace-relative image refs. */
  sid?: string;
  stale?: boolean;
  /**
   * Workspace-relative paths that still exist per the brief (source images +
   * logo). The user curates assets at review gates while the design artifact
   * keeps its old refs; tiles for brief-tracked refs (capture/, uploads/) not
   * in this list are hidden — matching what compose can actually use. Omit to
   * show everything. Design-generated assets/ refs are exempt (their deletion
   * removes the file, and the img error handler hides them at load time).
   */
  presentAssets?: string[];
}

const base = (p: string): string => p.split("/").pop() ?? p;

function refPresent(ref: string, presentAssets?: string[]): boolean {
  if (!presentAssets) return true;
  if (/^https?:\/\//.test(ref)) return true;
  if (ref.startsWith("assets/")) return true; // not brief-tracked
  const names = new Set(presentAssets.map(base));
  return names.has(base(ref));
}

/** Role labels for a hex, from design.colorRoles (e.g. "background", "accent"). */
function rolesOf(design: Design, hex: string): string[] {
  const roles = design.colorRoles;
  if (!roles) return [];
  const norm = hex.toLowerCase();
  return (
    [
      ["background", roles.background],
      ["surface", roles.surface],
      ["foreground", roles.foreground],
      ["accent", roles.accent],
    ] as const
  )
    .filter(([, value]) => value?.toLowerCase() === norm)
    .map(([role]) => role);
}

/** Resolve a design image ref: workspace-relative paths go through the files API. */
function imageSrc(sid: string | undefined, ref: string): string | null {
  if (/^https?:\/\//.test(ref)) return ref;
  return sid ? fileUrl(sid, ref) : null;
}

export function DesignBoard({ design, sid, stale = false, presentAssets }: Props): React.ReactElement {
  const keyVisuals = design.keyVisuals.filter(
    (v) => !v.refAssetId || refPresent(v.refAssetId, presentAssets),
  );
  // Role hexes the palette forgot to list still deserve a swatch.
  const roleOnlyHexes = design.colorRoles
    ? [design.colorRoles.background, design.colorRoles.surface, design.colorRoles.foreground, design.colorRoles.accent]
        .filter((hex): hex is string => !!hex)
        .filter((hex) => !design.palette.some((c) => c.hex.toLowerCase() === hex.toLowerCase()))
        .filter((hex, i, all) => all.indexOf(hex) === i)
    : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Design</CardTitle>
            {stale && <Badge variant="destructive">stale</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Mood"><p className="text-sm">{design.mood}</p></Row>
          <Row label="Motion"><p className="text-sm">{design.motion?.energy ? `${design.motion.energy} · ${design.motionStyle}` : design.motionStyle}</p></Row>
          <Row label="Typography">
            <p className="text-sm">
              <span className="font-medium">{design.typography.heading}</span>
              <span className="text-muted-foreground"> · {design.typography.body}</span>
            </p>
          </Row>
          <Row label="Palette">
            <div className="flex flex-wrap gap-3">
              {design.palette.map((c) => (
                <Swatch key={c.hex} hex={c.hex} name={c.name} roles={rolesOf(design, c.hex)} />
              ))}
              {roleOnlyHexes.map((hex) => (
                <Swatch key={hex} hex={hex} name="" roles={rolesOf(design, hex)} />
              ))}
            </div>
          </Row>
          {keyVisuals.length > 0 && (
            <Row label="Key visuals">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {keyVisuals.map((v, i) => {
                  const src = v.refAssetId ? imageSrc(sid, v.refAssetId) : null;
                  return src ? (
                    <KeyVisualTile key={i} src={src} description={v.description} />
                  ) : (
                    <p key={i} className="self-center text-sm">· {v.description}</p>
                  );
                })}
              </div>
            </Row>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {design.sampleFrames.map((f, i) => {
          const thumbPresent = !f.thumbnailUrl || refPresent(f.thumbnailUrl, presentAssets);
          const thumb = f.thumbnailUrl && thumbPresent ? imageSrc(sid, f.thumbnailUrl) : null;
          return <SampleFrameCard key={i} index={i} thumb={thumb} caption={f.caption} layoutHint={f.layoutHint} />;
        })}
      </div>
    </div>
  );
}

/** Key-visual tile that removes itself when its image fails to load (deleted design-generated asset). */
function KeyVisualTile({ src, description }: { src: string; description: string }): React.ReactElement | null {
  const [dead, setDead] = useState(false);
  if (dead) return null;
  return (
    <figure className="overflow-hidden rounded-xl bg-muted shadow-xs">
      <img
        src={src}
        alt={description}
        className="aspect-video w-full object-cover"
        onError={() => setDead(true)}
      />
      <figcaption className="truncate p-2 text-xs text-muted-foreground" title={description}>
        {description}
      </figcaption>
    </figure>
  );
}

function SampleFrameCard({ index, thumb, caption, layoutHint }: {
  index: number;
  thumb: string | null;
  caption: string;
  layoutHint: string;
}): React.ReactElement {
  // Deleted design-generated thumbnails 404 at load time — degrade to the
  // text-only card instead of a broken-image background.
  const [thumbDead, setThumbDead] = useState(false);
  const showThumb = thumb !== null && !thumbDead;
  return (
    <motion.article
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, delay: index * 0.04 }}
      // No fixed aspect ratio: layoutHint is LLM-authored prose and a
      // 16:9 box clips it. min-h keeps short cards frame-like; long
      // hints grow the card (the thumbnail covers whatever height).
      className="relative min-h-28 overflow-hidden rounded-xl bg-gradient-to-br from-muted to-muted/40 shadow-xs"
    >
      {showThumb && (
        <img
          src={thumb}
          alt={caption}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setThumbDead(true)}
        />
      )}
      <div className={`relative flex h-full flex-col justify-between gap-3 p-3 ${showThumb ? "bg-gradient-to-t from-black/60 via-black/10 to-transparent text-white" : ""}`}>
        <span className={`font-mono text-[10px] uppercase tracking-wide ${showThumb ? "text-white/70" : "text-muted-foreground"}`}>{layoutHint}</span>
        <p className="text-sm font-medium leading-tight">{caption}</p>
      </div>
    </motion.article>
  );
}

function Swatch({ hex, name, roles }: { hex: string; name: string; roles: string[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-8 w-8 rounded-lg shadow-xs ring-1 ring-inset ring-black/[0.06]" style={{ backgroundColor: hex }} />
      <div className="text-xs">
        <div className="font-medium">
          {name || roles[0] || ""}
          {roles.length > 0 && (
            <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              {roles.join("+")}
            </span>
          )}
        </div>
        <div className="font-mono text-muted-foreground">{hex}</div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h4>
      {children}
    </div>
  );
}
