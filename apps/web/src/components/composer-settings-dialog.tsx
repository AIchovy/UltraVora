"use client";
import {
  SlidersHorizontal,
  Clock,
  Ratio,
  AudioLines,
  Mic2,
  Captions,
  Music2,
  Globe2,
  type LucideIcon,
} from "lucide-react";
import {
  ALLOWED_DURATIONS,
  ALLOWED_ASPECT_RATIOS,
  resolutionLabel,
  type AspectRatio,
  type Duration,
  type Voice,
} from "@ultracreator/shared";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { VoicePicker } from "@/components/voice-picker";
import { cn } from "@/lib/utils";

interface Props {
  duration: Duration;
  onDurationChange: (d: Duration) => void;
  aspect: AspectRatio;
  onAspectChange: (a: AspectRatio) => void;
  voiceover: boolean;
  onVoiceoverChange: (v: boolean) => void;
  subtitles: boolean;
  onSubtitlesChange: (v: boolean) => void;
  bgm: boolean;
  onBgmChange: (v: boolean) => void;
  voice: Voice;
  onVoiceChange: (v: Voice) => void;
  isPublic: boolean;
  onIsPublicChange: (v: boolean) => void;
  /** True while the account's one free public generation is unclaimed. */
  freePublic: boolean;
}

// Decorative-only metadata for the aspect chips. `box` is the true-proportion
// preview rectangle drawn inside each chip; `caption` is the editorial kicker.
// NONE of this contributes to a control's accessible name — every visual child
// is wrapped aria-hidden and each button carries an explicit aria-label={ratio}.
const ASPECT_META: Record<
  AspectRatio,
  { caption: string; box: { w: string; h: string } }
> = {
  "16:9": { caption: "Landscape", box: { w: "36px", h: "20px" } },
  "9:16": { caption: "Portrait", box: { w: "20px", h: "36px" } },
  "1:1": { caption: "Square", box: { w: "28px", h: "28px" } },
};

function durationLabel(d: Duration): string {
  return d < 120 ? `${d}s` : `${d / 60}m`;
}

export function ComposerSettingsDialog({
  duration,
  onDurationChange,
  aspect,
  onAspectChange,
  voiceover,
  onVoiceoverChange,
  subtitles,
  onSubtitlesChange,
  bgm,
  onBgmChange,
  voice,
  onVoiceChange,
  isPublic,
  onIsPublicChange,
  freePublic,
}: Props): React.ReactElement {
  const active = voiceover || bgm || isPublic;
  return (
    <Dialog>
      <DialogTrigger
        aria-label="video settings"
        data-active={active ? "true" : undefined}
        className={cn(
          "cursor-pointer relative inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <SlidersHorizontal className="h-4 w-4" />
        <span>Settings</span>
        {active && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
        )}
      </DialogTrigger>

      {/* Zero out DialogContent's default p-6/gap-4 so the bands set their own
          rhythm. Cap the height to the viewport and lay the dialog out as a flex
          column so the header and footer stay pinned while only the section
          stack scrolls — keeps "Done" reachable on short screens (a 14" laptop)
          and adapts from phone to desktop. */}
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {/* Header — floating icon tile + visible title + one-line description. */}
        <DialogHeader className="shrink-0 gap-0 space-y-0 p-5 pb-4 text-left sm:p-7 sm:pb-5 sm:text-left">
          <div className="flex items-start gap-4">
            <div
              aria-hidden
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-card text-foreground shadow-card"
            >
              <SlidersHorizontal className="h-[22px] w-[22px]" strokeWidth={1.75} />
            </div>
            <div className="space-y-1.5 pt-0.5">
              <DialogTitle className="text-xl tracking-tight">Video settings</DialogTitle>
              <DialogDescription className="leading-relaxed">
                Shape the length, frame, and soundtrack of your video.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Body — each section floats on its own elevated panel, separated by
            air (gap-4), not hairlines: depth over strokes. This is the only
            scrolling region; min-h-0 lets it shrink below its content so
            overflow-y-auto engages instead of pushing the footer off-screen. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4 sm:gap-4 sm:px-7 sm:pb-5">
          <Section icon={Clock} label="Duration" caption="How long the finished video runs">
            <div
              role="group"
              aria-label="duration"
              className="grid grid-cols-3 gap-1.5 rounded-xl bg-muted p-1.5"
            >
              {ALLOWED_DURATIONS.map((d) => (
                <DurationChip key={d} active={duration === d} onClick={() => onDurationChange(d)}>
                  {durationLabel(d)}
                </DurationChip>
              ))}
            </div>
          </Section>

          <Section icon={Ratio} label="Aspect ratio" caption="The frame your video is composed for">
            <div role="group" aria-label="aspect ratio" className="grid grid-cols-3 gap-2.5">
              {ALLOWED_ASPECT_RATIOS.map((a) => {
                const meta = ASPECT_META[a];
                const selected = aspect === a;
                return (
                  <button
                    key={a}
                    type="button"
                    // Explicit aria-label forces the accessible name to the exact
                    // ratio; all visual children below are aria-hidden as well.
                    aria-label={a}
                    aria-pressed={selected}
                    onClick={() => onAspectChange(a)}
                    className={cn(
                      "group flex flex-col items-center justify-center gap-2.5 rounded-xl px-3 py-4 transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                      selected
                        ? "bg-card text-foreground shadow-raised"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {/* True-proportion preview rectangle — the hero of each chip. */}
                    <span
                      aria-hidden
                      className="flex h-10 items-center justify-center"
                    >
                      <span
                        style={{ width: meta.box.w, height: meta.box.h }}
                        className={cn(
                          "rounded-sm transition-colors",
                          selected
                            ? "bg-primary"
                            : "bg-muted-foreground/30 group-hover:bg-muted-foreground/45",
                        )}
                      />
                    </span>
                    <span aria-hidden className="text-sm font-medium leading-none">
                      {a}
                    </span>
                    <span
                      aria-hidden
                      className="text-[11px] font-medium uppercase leading-none tracking-wide text-muted-foreground"
                    >
                      {meta.caption}
                    </span>
                    <span aria-hidden className="text-[10px] leading-none text-muted-foreground/70 tabular-nums">
                      {resolutionLabel(a)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section icon={AudioLines} label="Audio" caption="Layer narration, captions, and a soundtrack">
            <div className="flex flex-col">
              <AudioRow icon={Mic2} label="Voiceover" helper="AI narration spoken over your video">
                <Switch checked={voiceover} onCheckedChange={onVoiceoverChange} aria-label="voiceover" />
              </AudioRow>
              {voiceover && (
                <div className="pb-3 pl-13">
                  <VoicePicker voice={voice} onVoiceChange={onVoiceChange} />
                </div>
              )}
              <RowDivider />
              <AudioRow
                icon={Captions}
                label="Subtitles"
                helper="On-screen captions synced to the voiceover"
                muted={!voiceover}
              >
                <Switch
                  checked={voiceover && subtitles}
                  onCheckedChange={onSubtitlesChange}
                  disabled={!voiceover}
                  aria-label="subtitles"
                />
              </AudioRow>
              <RowDivider />
              <AudioRow
                icon={Music2}
                label="Background music"
                helper="A soundtrack mixed underneath everything"
              >
                <Switch checked={bgm} onCheckedChange={onBgmChange} aria-label="background music" />
              </AudioRow>
            </div>
          </Section>

          <Section
            icon={Globe2}
            label="Public to plaza"
            caption="Show the finished video in the Product Plaza"
          >
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium leading-none text-foreground">
                  Publish this video
                  {freePublic && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
                      Free
                    </span>
                  )}
                </div>
                <p aria-hidden className="mt-1 text-xs leading-none text-muted-foreground">
                  Anyone can watch and like it on the plaza
                </p>
              </div>
              <div className="ml-auto pl-2">
                <Switch checked={isPublic} onCheckedChange={onIsPublicChange} aria-label="public to plaza" />
              </div>
            </div>
          </Section>
        </div>

        {/* Pinned footer — faint top hairline separates it from the scrolling
            body so "Done" stays anchored and always reachable. */}
        <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-4 sm:px-7 sm:py-5">
          <DialogClose asChild>
            <Button className="min-w-28">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon: Icon,
  label,
  caption,
  children,
}: {
  icon: LucideIcon;
  label: string;
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-3 rounded-2xl bg-card p-4 shadow-card sm:space-y-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold leading-none tracking-tight text-foreground">
            {label}
          </h3>
          <p aria-hidden className="text-xs leading-none text-muted-foreground">
            {caption}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function DurationChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-lg px-3 font-mono text-sm font-medium tabular-nums transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted",
        active
          ? "bg-card text-foreground shadow-raised"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {/* Accessible name MUST equal the exact label (e.g. "30s", "2m"). Keep the
          only child of this button equal to durationLabel(d) — no captions or
          icons belong inside. */}
      {children}
    </button>
  );
}

function AudioRow({
  icon: Icon,
  label,
  helper,
  muted,
  children,
}: {
  icon: LucideIcon;
  label: string;
  helper: string;
  muted?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cn("flex items-center gap-4 py-3 transition-opacity", muted && "opacity-50")}>
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-none text-foreground">{label}</div>
        <p aria-hidden className="mt-1 truncate text-xs leading-none text-muted-foreground">
          {helper}
        </p>
      </div>
      <div className="ml-auto pl-2">{children}</div>
    </div>
  );
}

function RowDivider(): React.ReactElement {
  return <div aria-hidden className="h-px bg-border" />;
}
