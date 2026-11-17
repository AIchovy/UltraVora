"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface Props {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: Props): React.ReactElement {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        "prose-p:my-1.5 prose-p:leading-relaxed",
        "prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold",
        "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-3",
        "prose-a:text-primary prose-a:underline prose-a:underline-offset-2",
        "prose-strong:font-semibold",
        "prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30 prose-blockquote:pl-3 prose-blockquote:italic",
        "text-foreground",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
