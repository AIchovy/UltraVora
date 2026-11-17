"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Paperclip, X, Send, Loader2 } from "lucide-react";
import { ALLOWED_DURATIONS, ALLOWED_ASPECT_RATIOS, type AspectRatio, type Duration } from "@ultracreator/shared";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { postMessage, uploadFiles } from "@/lib/api-client";

interface Props {
  sid: string;
  /** First-message mode: surfaces duration + aspect + voiceover; "Generate" CTA. */
  requireConstraints?: boolean;
  /** Optional callback after a successful submit (for clearing parent state etc.). */
  onSubmitted?: () => void;
  /** Echo the submitted message into the conversation (text + attached file names + correlation id). */
  onUserMessage?: (text: string, fileNames: string[], clientId: string) => void;
}

export function Composer({
  sid,
  requireConstraints = false,
  onSubmitted,
  onUserMessage,
}: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [duration, setDuration] = useState<Duration>(30);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [voiceover, setVoiceover] = useState(false);
  const [subtitles, setSubtitles] = useState(false);
  const [bgm, setBgm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (text.trim().length === 0) return;
    setBusy(true);
    const submittedText = text.trim();
    const submittedFileNames = files.map((f) => f.name);
    // Correlation id so the optimistic echo below dedupes against the server's
    // replayed user.message event (which survives reload) instead of doubling.
    const clientId = crypto.randomUUID();
    try {
      let uploadedFiles: string[] | undefined;
      if (files.length > 0) {
        const out = await uploadFiles(sid, files);
        uploadedFiles = out.files.map((f) => f.path);
      }
      await postMessage(sid, {
        text: text.trim(),
        clientId,
        ...(uploadedFiles ? { uploadedFiles } : {}),
        ...(requireConstraints
          ? {
              constraints: {
                durationSec: duration,
                aspectRatio: aspect,
                withVoiceover: voiceover,
                // Subtitles transcribe narration: only meaningful with voiceover.
                subtitles: voiceover && subtitles,
                // BGM is independent of voiceover.
                bgm,
              },
            }
          : {}),
      });
      onUserMessage?.(submittedText, submittedFileNames, clientId);
      setText("");
      setFiles([]);
      onSubmitted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-2xl bg-card p-3 shadow-raised ring-1 ring-transparent transition-shadow focus-within:ring-primary/25"
    >
      <Textarea
        placeholder={requireConstraints ? "Describe your product (or paste a URL)" : "Refine, ask, or instruct…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void handleSubmit(e as unknown as React.FormEvent);
          }
        }}
        rows={requireConstraints ? 3 : 2}
        disabled={busy}
        className="resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
      />

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
              {f.name}
              <button
                type="button"
                aria-label={`remove ${f.name}`}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Paperclip className="h-4 w-4" />
          <span>Attach files</span>
          <input
            type="file"
            multiple
            className="sr-only"
            aria-label="attach files"
            onChange={(e) => setFiles([...(files), ...Array.from(e.target.files ?? [])])}
          />
        </label>

        {requireConstraints && (
          <>
            <div role="group" aria-label="duration" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {ALLOWED_DURATIONS.map((d) => {
                const active = duration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDuration(d)}
                    className={cn(
                      "inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {d}s
                  </button>
                );
              })}
            </div>
            <div role="group" aria-label="aspect ratio" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {ALLOWED_ASPECT_RATIOS.map((a) => {
                const active = aspect === a;
                return (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setAspect(a)}
                    className={cn(
                      "inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {a}
                  </button>
                );
              })}
            </div>
            <label className="ml-auto flex items-center gap-2 text-xs">
              <Switch
                checked={voiceover}
                onCheckedChange={setVoiceover}
                aria-label="voiceover"
              />
              Voiceover
            </label>
            <label
              className={cn(
                "flex items-center gap-2 text-xs",
                !voiceover && "opacity-50",
              )}
              title={voiceover ? undefined : "Enable voiceover to add subtitles"}
            >
              <Switch
                checked={voiceover && subtitles}
                onCheckedChange={setSubtitles}
                disabled={!voiceover}
                aria-label="subtitles"
              />
              Subtitles
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={bgm}
                onCheckedChange={setBgm}
                aria-label="background music"
              />
              Background Music
            </label>
          </>
        )}

        <Button
          type="submit"
          disabled={busy}
          className={cn("rounded-lg", requireConstraints ? "" : "ml-auto")}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : !requireConstraints && <Send className="h-4 w-4" />}
          {requireConstraints ? "Generate" : "Send"}
        </Button>
      </div>
    </form>
  );
}
