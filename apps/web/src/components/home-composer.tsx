"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Loader2, ArrowUp, Plus, Link2, ImagePlus } from "lucide-react";
import {
  type AspectRatio,
  type Duration,
  type AssetRef,
  type Voice,
  ALLOWED_VOICES,
  DEFAULT_VOICE,
} from "@ultracreator/shared";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ModeSelect } from "@/components/mode-select";
import { ComposerSettingsDialog } from "@/components/composer-settings-dialog";
import { MentionPicker, type MentionItem } from "@/components/mention-picker";
import { PricingDialog } from "@/components/pricing/pricing-dialog";
import { cn } from "@/lib/utils";
import { createSession, postMessage, uploadFiles } from "@/lib/api-client";
import type { CreditsResponse } from "@/lib/api-types";
import { setPendingMessage } from "@/lib/pending-message";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useCredits } from "@/state/use-credits";

interface Props {
  text: string;
  onTextChange: (v: string) => void;
  duration: Duration;
  onDurationChange: (d: Duration) => void;
  aspect: AspectRatio;
  onAspectChange: (a: AspectRatio) => void;
  placeholder: string;
}

const URL_ERROR = "Enter a valid URL, like https://yourproduct.com";

/** Prefix a bare host ("acme.com") with https:// so it parses as a URL. */
function normalizeUrl(raw: string): string {
  const t = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

function hostOf(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A product URL the user could actually visit: http(s) and a real dotted host
 * with a letter TLD. `new URL` alone is too lax — it accepts "asdf" (parsed as
 * host "asdf") — so we also require the host to look like a domain.
 */
export function isValidProductUrl(raw: string): boolean {
  if (!raw.trim()) return false;
  let u: URL;
  try {
    u = new URL(normalizeUrl(raw));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(u.hostname);
}

// Splits composer text into plain runs and `@asset` mentions. Only labels that
// match a currently-attached asset are highlighted, so a mention stops being
// blue the moment its image is removed. Each mention is drawn in blue over a
// card-coloured (so invisible) background: the background hides the textarea's
// own charcoal glyphs beneath this overlay, leaving only crisp blue text, with
// no dark fringe. Keeping the weight identical to the textarea preserves
// alignment even with several mentions on one line.
function renderHighlightedText(text: string, labels: ReadonlySet<string>): React.ReactNode {
  if (labels.size === 0) return text;
  const nodes: React.ReactNode[] = [];
  const re = /(^|\s)@([A-Za-z0-9_]+)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = m[2]!;
    if (!labels.has(label)) continue;
    const at = m.index + m[1]!.length; // index of the '@'
    if (at > last) nodes.push(text.slice(last, at));
    nodes.push(
      <span key={key++} data-mention={label} className="bg-card text-blue-600">
        {`@${label}`}
      </span>,
    );
    last = at + 1 + label.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface ImageAsset {
  id: number;
  file: File;
  label: string;
  previewUrl: string;
}

export function HomeComposer({
  text,
  onTextChange,
  duration,
  onDurationChange,
  aspect,
  onAspectChange,
  placeholder,
}: Props): React.ReactElement {
  const router = useRouter();
  const qc = useQueryClient();
  const [productUrl, setProductUrl] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [logo, setLogo] = useState<File | null>(null);
  // Composer audio prefs + the Chat/Auto-pilot choice all survive a refresh.
  // JSON.stringify(true) === "true", so this stays compatible with the boolean
  // strings the old inline `uc.autoApprove` handling wrote.
  const [voiceover, setVoiceover] = usePersistentState("uc.voiceover", false);
  const [subtitles, setSubtitles] = usePersistentState("uc.subtitles", false);
  const [bgm, setBgm] = usePersistentState("uc.bgm", false);
  const isVoice = (v: unknown): v is Voice =>
    typeof v === "string" && (ALLOWED_VOICES as readonly string[]).includes(v);
  const [voice, setVoice] = usePersistentState<Voice>("uc.voice", DEFAULT_VOICE, isVoice);
  const [busy, setBusy] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [autoApprove, setAutoApprove] = usePersistentState("uc.autoApprove", true);
  const [isPublic, setIsPublic] = usePersistentState("uc.isPublic", false);
  // Subscribed (not a one-shot cache read): the settings dialog shows the Free
  // pill whenever the grant is unclaimed, so it must appear as soon as the
  // credits query lands — not only after some unrelated re-render.
  const freePublicAvailable = useCredits().data?.freePublicAvailable ?? false;

  const logoPreview = useMemo(
    () => (logo && typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(logo) : null),
    [logo],
  );
  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

  const [images, setImages] = useState<ImageAsset[]>([]);
  const imageCounter = useRef(0);

  const MAX_IMAGES = 5; // logo counts toward this cap
  const imageCount = images.length + (logo ? 1 : 0);

  // jsdom (tests) lacks URL.createObjectURL/revokeObjectURL — guard like logoPreview does.
  const makePreview = (file: File): string =>
    typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(file) : "";
  const dropPreview = (url: string): void => {
    if (url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
  };

  function addImages(files: File[]) {
    setImages((prev) => {
      const room = MAX_IMAGES - (prev.length + (logo ? 1 : 0));
      const next = files.slice(0, Math.max(0, room)).map((file) => {
        imageCounter.current += 1;
        return {
          id: imageCounter.current,
          file,
          label: `image${imageCounter.current}`,
          previewUrl: makePreview(file),
        };
      });
      return [...prev, ...next];
    });
  }

  function removeImage(id: number) {
    setImages((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) dropPreview(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  // Revoke every still-attached preview on unmount (e.g. SPA navigation away
  // before generating). A ref keeps the cleanup reading the live set, not the
  // empty mount-time snapshot.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    return () => imagesRef.current.forEach((a) => dropPreview(a.previewUrl));
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);

  const mentionAssets: MentionItem[] = [
    ...(logo ? [{ label: "logo", previewUrl: logoPreview }] : []),
    ...images.map((a) => ({ label: a.label, previewUrl: a.previewUrl })),
  ];
  const mentionLabelSet = new Set(mentionAssets.map((a) => a.label));

  // The @-fragment immediately before the caret, or null. Triggers only at
  // string start or after whitespace, with no whitespace between @ and caret.
  function mentionQuery(): { start: number; query: string } | null {
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  const mq = mentionQuery();
  const mentionMatches = mq
    ? mentionAssets.filter((a) => a.label.toLowerCase().startsWith(mq.query.toLowerCase()))
    : [];
  const mentionOpen = mq !== null && mentionMatches.length > 0 && !mentionSuppressed;
  // Clamp: the match list can shrink (typing narrows it) while mentionActive
  // still points past the end — keep the highlight/selection in range.
  const mentionIndex = Math.min(mentionActive, Math.max(0, mentionMatches.length - 1));

  function insertMention(label: string) {
    if (!mq) return;
    const before = text.slice(0, mq.start);
    const after = text.slice(caret);
    const next = `${before}@${label} ${after}`;
    onTextChange(next);
    setMentionActive(0);
    const pos = before.length + label.length + 2; // past "@label "
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  }

  const canSubmit = text.trim().length > 0 || productUrl.trim().length > 0;

  async function handleGenerate() {
    if (busy) return;
    const url = productUrl.trim();
    // The URL is optional, but if one was typed it must be a real URL — don't
    // silently send junk to the research step.
    if (url && !isValidProductUrl(url)) {
      setUrlError(URL_ERROR);
      setUrlOpen(true);
      return;
    }
    if (!canSubmit) return;
    // Out of credits → inform + open the upgrade modal instead of starting a run.
    // An unknown balance (still loading) proceeds; the in-session gate is the
    // backstop for anything past the first step.
    const balance = qc.getQueryData<CreditsResponse>(["credits"])?.balance;
    const freeRun = isPublic && freePublicAvailable;
    if (!freeRun && balance !== undefined && balance <= 0) {
      setUpgradeOpen(true);
      return;
    }
    setBusy(true);
    const trimmed = text.trim();
    const bubble = trimmed || `Promo for ${hostOf(url)}`;
    const messageText = url ? `${trimmed ? `${trimmed}\n\n` : ""}Product page: ${url}`.trim() : trimmed;
    const orderedAssets: { file: File; label: string; role: "logo" | "image" }[] = [
      ...(logo ? [{ file: logo, label: "logo", role: "logo" as const }] : []),
      ...images.map((a) => ({ file: a.file, label: a.label, role: "image" as const })),
    ];
    // Correlation id shared between the POSTed message and the pending-bubble
    // handoff, so the echo on the session page dedupes against the server's
    // replayed user.message event instead of showing twice.
    const clientId = crypto.randomUUID();
    try {
      const { sessionId } = await createSession({
        autoApprove,
        ...(isPublic ? { isPublic: true } : {}),
        ...(url ? { productUrl: normalizeUrl(url) } : {}),
      });
      let uploadedFiles: string[] | undefined;
      let assets: AssetRef[] | undefined;
      if (orderedAssets.length > 0) {
        const out = await uploadFiles(sessionId, orderedAssets.map((a) => a.file));
        uploadedFiles = out.files.map((f) => f.path);
        assets = orderedAssets.map((a, i) => ({ label: a.label, path: out.files[i]!.path, role: a.role }));
      }
      await postMessage(sessionId, {
        text: messageText,
        clientId,
        ...(uploadedFiles ? { uploadedFiles } : {}),
        ...(assets ? { assets } : {}),
        constraints: {
          durationSec: duration,
          aspectRatio: aspect,
          withVoiceover: voiceover,
          subtitles: voiceover && subtitles,
          bgm,
          voice,
        },
      });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      setPendingMessage(sessionId, { text: bubble, files: orderedAssets.map((a) => a.file.name), clientId });
      router.push(`/s/${sessionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the project");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl bg-card p-4 shadow-panel ring-1 ring-transparent transition-shadow focus-within:ring-primary/20">
      {/* Promo inputs: a product URL and a brand logo */}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={() => setUrlOpen((v) => !v)}
          aria-expanded={urlOpen}
          className={cn(
            "cursor-pointer flex h-20 w-28 flex-col items-center justify-center gap-1.5 rounded-2xl transition-colors",
            productUrl ? "bg-accent text-accent-foreground" : "bg-muted/70 text-muted-foreground hover:bg-muted",
          )}
        >
          <Link2 className="h-5 w-5" />
          <span className="text-xs font-medium uppercase tracking-wide">URL</span>
          {productUrl && <span className="max-w-[6.5rem] truncate text-[11px] font-normal">{hostOf(productUrl)}</span>}
        </button>

        <label className="relative flex h-20 w-28 cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-2xl bg-muted/70 text-muted-foreground transition-colors hover:bg-muted">
          {logoPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoPreview} alt="Product logo" className="h-full w-full object-contain p-2" />
          ) : (
            <>
              <ImagePlus className="h-5 w-5" />
              <span className="text-xs font-medium uppercase tracking-wide">Logo</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="upload product logo"
            onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
          />
        </label>

        {images.map((a) => (
          <div key={a.id} className="relative h-20 w-20 overflow-hidden rounded-2xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.previewUrl} alt={a.label} className="h-full w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-medium text-white">
              @{a.label}
            </span>
            <button
              type="button"
              aria-label={`remove ${a.label}`}
              onClick={() => removeImage(a.id)}
              className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {urlOpen && (
        <div className="mt-2.5">
          <input
            type="url"
            inputMode="url"
            autoFocus
            value={productUrl}
            onChange={(e) => {
              setProductUrl(e.target.value);
              if (urlError) setUrlError(undefined); // clear as they fix it
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              setUrlError(v && !isValidProductUrl(v) ? URL_ERROR : undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setUrlOpen(false);
              }
            }}
            placeholder="https://yourproduct.com"
            aria-label="product url"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? "product-url-error" : undefined}
            className={cn(
              "w-full rounded-xl bg-muted/60 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2",
              urlError ? "ring-2 ring-destructive/50 focus:ring-destructive/50" : "focus:ring-primary/20",
            )}
          />
          {urlError && (
            <p id="product-url-error" role="alert" className="mt-1.5 text-xs text-destructive">
              {urlError}
            </p>
          )}
        </div>
      )}

      <div className="relative mt-3">
        {/* Highlight overlay — mirrors the textarea's text but paints each known
            @asset mention in blue. It sits on top (pointer-events disabled) and
            recolors the real, editable text in the textarea beneath. Non-mention
            text is rendered transparent here; it only preserves layout so the
            blue mentions stay aligned, and it leaves the textarea's own text
            (and IME composition) visible through it. */}
        <div
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-1 text-[15px] leading-normal text-transparent"
        >
          {renderHighlightedText(text, mentionLabelSet)}
        </div>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMentionSuppressed(false); // typing re-opens the picker after an Escape
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onScroll={(e) => {
            // Keep the highlight overlay glued to the textarea when it scrolls.
            if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // let the IME handle keys mid-composition
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionActive((i) => (i + 1) % mentionMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionActive((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                insertMention(mentionMatches[mentionIndex]!.label);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionSuppressed(true); // collapse the picker until the next keystroke
                setMentionActive(0); // next time it opens, start at the top
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleGenerate();
            }
          }}
          placeholder={placeholder}
          rows={3}
          disabled={busy}
          className="resize-none border-0 bg-transparent p-1 text-[15px] leading-normal shadow-none focus-visible:ring-0"
        />
        {mentionOpen && (
          <MentionPicker items={mentionMatches} activeIndex={mentionIndex} onSelect={insertMention} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors",
            imageCount >= MAX_IMAGES
              ? "cursor-not-allowed opacity-40"
              : "cursor-pointer hover:bg-muted hover:text-foreground",
          )}
        >
          <Plus className="h-4 w-4" />
          <span>Attach</span>
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={imageCount >= MAX_IMAGES}
            className="sr-only"
            aria-label="attach images"
            onChange={(e) => {
              addImages(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </label>

        <ComposerSettingsDialog
          duration={duration}
          onDurationChange={onDurationChange}
          aspect={aspect}
          onAspectChange={onAspectChange}
          voiceover={voiceover}
          onVoiceoverChange={setVoiceover}
          subtitles={subtitles}
          onSubtitlesChange={setSubtitles}
          bgm={bgm}
          onBgmChange={setBgm}
          voice={voice}
          onVoiceChange={setVoice}
          isPublic={isPublic}
          onIsPublicChange={setIsPublic}
          freePublic={freePublicAvailable}
        />

        <div className="ml-auto flex items-center gap-1">
          <ModeSelect autoApprove={autoApprove} onChange={setAutoApprove} />
          <Button
            onClick={handleGenerate}
            disabled={busy || !canSubmit}
            size="icon"
            aria-label="Generate"
            className="rounded-full"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <PricingDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        mode="app"
        notice="You're out of credits. Upgrade to keep creating videos."
      />
    </div>
  );
}

