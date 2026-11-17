"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Code,
  Clapperboard,
  Copy,
  Download,
  FileText,
  Globe,
  Image,
  Info,
  Loader2,
  Music,
  Package,
  PauseCircle,
  Sparkles,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  groupConversation,
  type ConversationBlock,
  type PhaseStatus,
  type ToolStatus,
} from "@/lib/group-conversation";
import type { ChatItem } from "@/state/session-reducer";
import { Markdown } from "./markdown";
import { MatrixLoader } from "./matrix-loader";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  items: ChatItem[];
  loading?: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  research: "Research",
  design: "Design",
  script: "Script",
  voiceover: "Voiceover",
  compose: "Compose",
  render: "Render",
};

const STATUS_TEXT: Record<PhaseStatus, string> = {
  running: "working…",
  awaiting: "awaiting approval",
  error: "failed",
  done: "done",
};

const TOOL_ICONS: Record<string, React.ElementType> = {
  generate_image: Image,
  generate_music: Music,
  web_fetch: Globe,
  download_asset: Download,
  write_brief: FileText,
  write_design: FileText,
  write_script: FileText,
  write_composition_file: Code,
  read_skill_file: BookOpen,
  read_upload: FileText,
  add_registry_item: Package,
  add_sound_effect: Music,
};

// Plain-language labels for the activity feed. The server sends a title-cased
// fallback (e.g. "Read Skill File"); anything not listed here uses that.
const TOOL_LABELS: Record<string, string> = {
  read_skill_file: "Reading guidelines",
  read_upload: "Reading your upload",
  web_fetch: "Browsing the web",
  download_asset: "Downloading media",
  generate_image: "Generating an image",
  generate_music: "Composing music",
  write_brief: "Writing the brief",
  write_design: "Designing the look",
  write_script: "Writing the script",
  write_composition_file: "Building the video",
  add_registry_item: "Adding a component",
  add_sound_effect: "Adding sound design",
};

export function ChatStream({ items, loading = false }: Props): React.ReactElement {
  const reduce = useReducedMotion();
  const blocks = groupConversation(items);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "end" });
  }, [items.length, reduce]);

  if (loading) {
    return <ChatStreamSkeleton />;
  }

  if (blocks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Sparkles className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">Waiting for the agent. Nothing yet.</p>
      </div>
    );
  }

  const grouped = groupToolBlocks(blocks);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 p-4">
        {grouped.map((entry, i) => {
          if (entry.type === "single") {
            return (
              <BlockRenderer
                key={i}
                block={entry.block}
                defaultOpen={i === grouped.length - 1}
                reduce={!!reduce}
              />
            );
          }
          return (
            <ActionGroup
              key={i}
              tools={entry.tools}
              defaultOpen={i === grouped.length - 1}
              reduce={!!reduce}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ChatStreamSkeleton(): React.ReactElement {
  // The conversation panel is itself bg-muted, so the default bg-muted Skeleton
  // would be invisible here — tint these blocks with a faint foreground wash so
  // they read against the muted surface (the preview side keeps bg-muted on its
  // white canvas).
  return (
    <div className="flex h-full flex-col gap-4 p-4" role="status" aria-label="Loading conversation">
      <Skeleton className="ml-auto h-10 w-3/5 rounded-2xl rounded-br-sm bg-foreground/10" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-[90%] bg-foreground/10" />
            <Skeleton className="h-3 w-[65%] bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

type GroupedEntry =
  | { type: "single"; block: ConversationBlock }
  | { type: "action-group"; tools: Extract<ConversationBlock, { kind: "tool" }>[] };

function groupToolBlocks(blocks: ConversationBlock[]): GroupedEntry[] {
  const result: GroupedEntry[] = [];
  let toolBuf: Extract<ConversationBlock, { kind: "tool" }>[] = [];

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    if (toolBuf.length >= 3) {
      result.push({ type: "action-group", tools: [...toolBuf] });
    } else {
      for (const t of toolBuf) result.push({ type: "single", block: t });
    }
    toolBuf = [];
  };

  for (const block of blocks) {
    if (block.kind === "tool") {
      toolBuf.push(block);
    } else {
      flushTools();
      result.push({ type: "single", block });
    }
  }
  flushTools();
  return result;
}

function BlockRenderer({
  block,
  defaultOpen,
  reduce,
}: {
  block: ConversationBlock;
  defaultOpen: boolean;
  reduce: boolean;
}): React.ReactElement {
  const enter = reduce ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

  switch (block.kind) {
    case "user":
      return <UserBlock text={block.text} files={block.files} at={block.at} enter={enter} />;

    case "render-done":
      return (
        <motion.div {...enter} transition={{ duration: 0.18 }}>
          <div className="flex items-start gap-2 rounded-lg bg-card px-3 py-2 text-sm shadow-xs">
            <Clapperboard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <span className="font-medium">Video rendered.</span>{" "}
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground break-all">
                {block.mp4Path.replace(/^.*[\\/]/, "")}
              </code>
            </div>
          </div>
        </motion.div>
      );

    case "artifact":
      return (
        <motion.div {...enter} transition={{ duration: 0.18 }} className="flex justify-start pl-9">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-xs">
            <FileText className="h-3.5 w-3.5" />
            {`${block.artifactKind} v${block.version}`}
          </span>
        </motion.div>
      );

    case "phase":
      return <PhaseGroup block={block} defaultOpen={defaultOpen} enter={enter} />;

    case "thinking-active":
      return <ThinkingActive enter={enter} />;

    case "thinking":
      return <ThinkingBlock text={block.text} enter={enter} />;

    case "agent-text":
      return <AgentTextBlock text={block.text} isFinal={block.isFinal} enter={enter} />;

    case "tool":
      return <ToolCallRow tool={block} enter={enter} />;

    case "notice":
      return (
        <motion.div {...enter} transition={{ duration: 0.18 }} className="flex justify-start pl-9">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            {block.message}
          </span>
        </motion.div>
      );
  }
}

/* ── User Message Bubble ──────────────────────────────────────────────────── */

function UserBlock({
  text,
  files,
  at,
  enter,
}: {
  text: string;
  files?: string[];
  at?: number;
  enter: Record<string, unknown>;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — clipboard unavailable");
    }
  };

  return (
    <motion.div
      {...enter}
      transition={{ duration: 0.18 }}
      className="group flex flex-col items-end gap-1"
    >
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm">
        <p className="whitespace-pre-wrap break-words">{text}</p>
        {files && files.length > 0 && (
          <p className="mt-1 text-xs text-primary-foreground/75">
            {files.length} attachment{files.length > 1 ? "s" : ""}
          </p>
        )}
      </div>
      {/* Meta row: timestamp + copy. Always reserves its height so revealing it on
          hover never shifts the conversation; opacity fades it in on hover/focus. */}
      <div className="flex h-5 items-center gap-2 pr-0.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {at != null && (
          <time dateTime={new Date(at).toISOString()}>
            {new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label="Copy message"
          className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </motion.div>
  );
}

/* ── Thinking Active (matrix loader) ──────────────────────────────────────── */

function ThinkingActive({
  enter,
}: {
  enter: Record<string, unknown>;
}): React.ReactElement {
  return (
    <motion.div
      {...enter}
      transition={{ duration: 0.18 }}
      className="flex items-center gap-2.5 py-2"
    >
      <MatrixLoader size={24} />
      <span className="text-xs text-muted-foreground">Thinking…</span>
    </motion.div>
  );
}

/* ── Thinking Block (completed, collapsible) ─────────────────────────────── */

function ThinkingBlock({
  text,
  enter,
}: {
  text: string;
  enter: Record<string, unknown>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <motion.div {...enter} transition={{ duration: 0.18 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm shadow-xs hover:bg-card/80 transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/80">Thinking</span>
        <ChevronRight
          className={cn(
            "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="mt-1 ml-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-foreground/70 font-mono leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </motion.div>
  );
}

/* ── Agent Text Block ─────────────────────────────────────────────────────── */

function AgentTextBlock({
  text,
  isFinal,
  enter,
}: {
  text: string;
  isFinal: boolean;
  enter: Record<string, unknown>;
}): React.ReactElement {
  return (
    <motion.div {...enter} transition={{ duration: 0.18 }} className="py-1">
      <Markdown className="text-sm">
        {text}
      </Markdown>
      {!isFinal && (
        <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse rounded-sm ml-0.5 align-text-bottom" />
      )}
    </motion.div>
  );
}

/* ── Tool Call Row ────────────────────────────────────────────────────────── */

function ToolCallRow({
  tool,
  enter,
}: {
  tool: Extract<ConversationBlock, { kind: "tool" }>;
  enter: Record<string, unknown>;
}): React.ReactElement {
  const Icon = TOOL_ICONS[tool.toolName] ?? Wrench;
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolLabel;
  // The args-derived subject (a file name, host, or prompt snippet) describes
  // what the tool acted on, so keep showing it once the tool finishes. A result
  // summary is only present on error (a short reason), so it takes precedence.
  const summary =
    tool.status === "done" || tool.status === "error"
      ? (tool.resultSummary ?? tool.argsSummary)
      : tool.argsSummary;

  return (
    <motion.div
      {...enter}
      transition={{ duration: 0.18 }}
      className="flex items-center gap-2 py-1 text-sm"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground/90">{label}</span>
      {summary && (
        <span className="ml-auto truncate max-w-[40%] text-xs text-muted-foreground/70">
          {summary}
        </span>
      )}
      <ToolStatusIcon status={tool.status} className={summary ? undefined : "ml-auto"} />
    </motion.div>
  );
}

function ToolStatusIcon({ status, className }: { status: ToolStatus; className?: string }): React.ReactElement {
  switch (status) {
    case "running":
      return <Loader2 className={cn("h-4 w-4 shrink-0 animate-spin text-primary", className)} />;
    case "done":
      return <CheckCircle2 className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} />;
    case "error":
      return <AlertTriangle className={cn("h-4 w-4 shrink-0 text-destructive", className)} />;
  }
}

/* ── Action Group (collapsible 3+ consecutive tools) ──────────────────────── */

function ActionGroup({
  tools,
  defaultOpen,
  reduce,
}: {
  tools: Extract<ConversationBlock, { kind: "tool" }>[];
  defaultOpen: boolean;
  reduce: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const enter = reduce ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

  const allDone = tools.every((t) => t.status === "done" || t.status === "error");
  const hasError = tools.some((t) => t.status === "error");
  const running = tools.filter((t) => t.status === "running").length;

  return (
    <motion.div {...enter} transition={{ duration: 0.18 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm shadow-xs hover:bg-card/80 transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <span className="font-medium">
          {tools.length} Action{tools.length > 1 ? "s" : ""}
        </span>
        {running > 0 && (
          <span className="text-xs text-muted-foreground">
            {running} running…
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {allDone ? (
            hasError ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            )
          ) : (
            <MatrixLoader size={18} />
          )}
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 pl-2">
          {tools.map((tool) => (
            <ToolCallRow key={tool.toolCallId} tool={tool} enter={{}} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

/* ── Phase Group (existing, for backward-compat progress strings) ─────────── */

function PhaseGroup({
  block,
  defaultOpen,
  enter,
}: {
  block: Extract<ConversationBlock, { kind: "phase" }>;
  defaultOpen: boolean;
  enter: Record<string, unknown>;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = block.steps.length > 0 || block.artifacts.length > 0 || !!block.error;
  const label = PHASE_LABEL[block.phase] ?? block.phase;

  return (
    <motion.div {...enter} transition={{ duration: 0.18 }}>
      <div className="rounded-lg bg-card shadow-xs transition-colors">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
            hasDetail && "cursor-pointer hover:bg-card/80",
          )}
          aria-expanded={hasDetail ? open : undefined}
        >
          <span className="font-medium">{label}</span>
          <span
            className={cn(
              "text-xs",
              block.status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {STATUS_TEXT[block.status]}
          </span>
          {block.steps.length > 0 && (
            <span className="text-xs text-muted-foreground/70">
              · {block.steps.length} step{block.steps.length > 1 ? "s" : ""}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <PhaseStatusIcon status={block.status} />
            {hasDetail && (
              <ChevronRight
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
            )}
          </span>
        </button>

        {open && hasDetail && (
          <div className="space-y-1.5 px-3 pb-3">
            {block.steps.map((step, i) => (
              <p key={i} className="flex items-start gap-2 text-xs text-muted-foreground break-all">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                {step}
              </p>
            ))}
            {block.error && <p className="text-xs text-destructive break-all">{block.error}</p>}
            {block.artifacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {block.artifacts.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    <FileText className="h-3 w-3" />
                    {`${a.artifactKind} v${a.version}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PhaseStatusIcon({ status }: { status: PhaseStatus }): React.ReactElement {
  switch (status) {
    case "running":
      return <MatrixLoader size={18} />;
    case "awaiting":
      return <PauseCircle className="h-4 w-4 shrink-0 text-primary" />;
    case "error":
      return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}
