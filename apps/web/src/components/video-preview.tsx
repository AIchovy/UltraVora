"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Captions, Loader2 } from "lucide-react";
import type { PhaseId } from "@ultracreator/shared";
import { fileUrl, getArtifact } from "@/lib/api-client";
import { segmentsToVtt } from "@/lib/segments-to-vtt";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Live run info while the server regenerates a video that already exists. */
export interface RegenerationInfo {
  phase: PhaseId | null;
  renderPercent: number;
}

interface Props { sid: string; mp4Path: string; regenerating?: RegenerationInfo | null }

export function VideoPreview({ sid, mp4Path, regenerating = null }: Props): React.ReactElement {
  const src = fileUrl(sid, mp4Path);
  const subs = useQuery({
    queryKey: ["artifact", sid, "subtitles"],
    queryFn: () => getArtifact(sid, "subtitles"),
  });
  const srtPath = subs.data?.data.srtPath;
  const srtUrl = srtPath ? fileUrl(sid, srtPath) : null; // .srt download link only
  const segments = subs.data?.data.segments;

  const [ccOn, setCcOn] = useState(true);
  const [vttUrl, setVttUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Build the WebVTT <track> from the segments already in the artifact — no
  // second network hop. Fetching the .srt would 302 to a cross-origin GCS URL
  // once archived, where fetch() (unlike <video>) is blocked without CORS.
  useEffect(() => {
    if (!segments || segments.length === 0) { setVttUrl(null); return; }
    const url = URL.createObjectURL(new Blob([segmentsToVtt(segments)], { type: "text/vtt" }));
    setVttUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [segments]);

  // Keep the native TextTrack mode in sync with the toggle, including when the
  // <track> finishes loading after mount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const apply = (): void => {
      const track = video.textTracks[0];
      if (track) track.mode = ccOn ? "showing" : "hidden";
    };
    apply();
    video.textTracks.addEventListener?.("addtrack", apply);
    return () => video.textTracks.removeEventListener?.("addtrack", apply);
  }, [ccOn, vttUrl]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Video</CardTitle>
          <div className="flex items-center gap-3">
            {vttUrl && (
              <button
                type="button"
                onClick={() => setCcOn((v) => !v)}
                aria-pressed={ccOn}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Captions className="h-3.5 w-3.5" /> Captions {ccOn ? "on" : "off"}
              </button>
            )}
            {srtUrl && (
              <a href={srtUrl} download className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Download className="h-3.5 w-3.5" /> .srt
              </a>
            )}
            <a href={src} download className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <video ref={videoRef} src={src} controls className="aspect-video w-full rounded-xl bg-black shadow-raised">
            {vttUrl && <track kind="subtitles" srcLang="en" label="English" src={vttUrl} default />}
          </video>
          {regenerating && (
            // Floating pill only — the old cut stays visible and playable while
            // the server produces the next version.
            <span
              role="status"
              className="pointer-events-none absolute left-1/2 top-3 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground shadow-raised backdrop-blur"
            >
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-primary" />
              {regenerating.phase === "render" && regenerating.renderPercent > 0
                ? `Re-rendering… ${Math.round(regenerating.renderPercent)}%`
                : "Updating video…"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
