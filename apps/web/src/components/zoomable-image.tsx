"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Props {
  src: string;
  alt: string;
  /** Classes for the thumbnail <img>. */
  className?: string;
  /** Classes for the wrapping trigger button. */
  buttonClassName?: string;
  /** Caption under the enlarged image (defaults to none). */
  caption?: string;
}

/**
 * Thumbnail that opens a near-fullscreen lightbox on click. Grid thumbnails
 * shrink or crop captures past legibility; the dialog shows the image
 * uncropped (object-contain, capped to the viewport).
 */
export function ZoomableImage({ src, alt, className, buttonClassName, caption }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={buttonClassName ?? "block w-full cursor-zoom-in"}
        aria-label={`Enlarge ${caption ?? alt}`}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} className={className} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* DialogContent bakes in sm:max-w-lg; a bare max-w-* loses to it via
            tailwind-merge, so the sm: variant itself must be overridden. */}
        <DialogContent className="w-fit max-w-[92vw] p-2 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">{caption ?? alt}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[85vh] w-auto max-w-full rounded-lg object-contain" />
          {caption && (
            <p className="truncate px-1 pb-1 text-center text-xs text-muted-foreground">{caption}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
