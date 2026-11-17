"use client";
import { useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { VOICES, type Voice } from "@ultracreator/shared";
import { voiceSampleUrl } from "@/lib/voice-sample-url";
import { cn } from "@/lib/utils";

interface Props {
  voice: Voice;
  onVoiceChange: (v: Voice) => void;
}

export function VoicePicker({ voice, onVoiceChange }: Props): React.ReactElement {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Voice | null>(null);

  function stop(): void {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setPlaying(null);
  }

  function preview(name: Voice): void {
    const a = audioRef.current;
    if (!a) return;
    if (playing === name) {
      stop();
      return;
    }
    a.pause();
    a.src = voiceSampleUrl(name);
    setPlaying(name);
    // Media errors (offline, missing object) just reset the button — no toast.
    void a.play().catch(() => setPlaying(null));
  }

  return (
    <div
      role="radiogroup"
      aria-label="voice"
      className="max-h-56 space-y-1 overflow-y-auto rounded-xl bg-muted/60 p-1.5"
    >
      {/* Single shared element, kept out of the a11y tree. */}
      <audio ref={audioRef} aria-hidden className="hidden" onEnded={() => setPlaying(null)} />
      {VOICES.map((v) => {
        const selected = v.name === voice;
        const isPlaying = playing === v.name;
        return (
          <div
            key={v.name}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors",
              selected ? "bg-card shadow-raised" : "hover:bg-card/60",
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={v.name}
              onClick={() => onVoiceChange(v.name)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <span className="text-sm font-medium text-foreground">{v.name}</span>
              <span aria-hidden className="flex flex-wrap gap-1">
                {v.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </span>
            </button>
            <button
              type="button"
              aria-label={`preview ${v.name}`}
              onClick={() => preview(v.name)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isPlaying ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
