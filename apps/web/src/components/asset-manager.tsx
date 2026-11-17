"use client";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ImagePlus, Loader2, X } from "lucide-react";
import { fileUrl, patchBriefAssets, uploadFiles } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/zoomable-image";

interface Props {
  sid: string;
  logoFile?: string;
  images?: string[];
}

/**
 * Source-asset curation for review gates: low-quality captured
 * screenshots drag every downstream artifact down, so the user can drop them
 * and upload better product shots before approving. Mutations write a new
 * brief version; the server answers 409 while a phase is actively running.
 */
export function AssetManager({ sid, logoFile, images = [] }: Props): React.ReactElement {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const gallery = images.filter((p) => p && p !== logoFile);

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({ queryKey: ["artifact", sid, "brief"] });
  }

  async function removeAsset(path: string): Promise<void> {
    setBusyPath(path);
    try {
      await patchBriefAssets(sid, { remove: [path] });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the image");
    } finally {
      setBusyPath(null);
    }
  }

  async function addImages(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setAdding(true);
    try {
      const uploaded = await uploadFiles(sid, Array.from(list));
      await patchBriefAssets(sid, { add: uploaded.files.map((f) => f.path) });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the images");
    } finally {
      setAdding(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-3">
      {logoFile && (
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Logo</h4>
          <ZoomableImage
            src={fileUrl(sid, logoFile)}
            alt="Brand logo"
            caption={logoFile}
            buttonClassName="inline-block cursor-zoom-in"
            className="h-16 w-auto rounded-xl bg-muted object-contain p-2 shadow-xs"
          />
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source assets</h4>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            disabled={adding}
            onClick={() => fileInput.current?.click()}
          >
            {adding ? (
              <Loader2 aria-hidden className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImagePlus aria-hidden className="mr-1 h-3.5 w-3.5" />
            )}
            Add images
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            aria-label="add images"
            onChange={(e) => void addImages(e.target.files)}
          />
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          These images are used in your video. Remove low-quality captures and upload better
          product shots before approving — only the images kept here flow into the next steps.
        </p>
        {gallery.length === 0 ? (
          <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">
            No source images — the video will rely on generated imagery. Upload product shots
            with “Add images”.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
            {gallery.map((path) => (
              <div key={path} className="relative">
                <ZoomableImage
                  src={fileUrl(sid, path)}
                  alt="Source asset"
                  caption={path}
                  className="aspect-square w-full rounded-xl bg-muted object-contain p-1 shadow-xs"
                />
                <button
                  type="button"
                  aria-label={`Remove ${path}`}
                  disabled={busyPath === path}
                  onClick={() => void removeAsset(path)}
                  className="absolute right-1 top-1 rounded-full bg-background/90 p-1 opacity-80 shadow-xs transition-opacity hover:opacity-100 disabled:opacity-50"
                >
                  {busyPath === path ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X aria-hidden className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
