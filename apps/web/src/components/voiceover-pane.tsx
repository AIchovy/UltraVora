"use client";
import { useQuery } from "@tanstack/react-query";
import { Music } from "lucide-react";
import type { MusicData, NarrationData } from "@ultracreator/shared";
import { getArtifact } from "@/lib/api-client";
import { buildAudioTracks } from "@/lib/audio-tracks";
import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerControlGroup,
  AudioPlayerPlay,
  AudioPlayerSeekBar,
  AudioPlayerSkipBack,
  AudioPlayerSkipForward,
  AudioPlayerTimeDisplay,
  AudioPlayerVolume,
  AudioTrackList,
} from "@/components/audio/player";

interface Props {
  sid: string;
  stale: boolean;
}

export function VoiceoverPane({ sid, stale }: Props): React.ReactElement {
  const narration = useQuery({
    queryKey: ["artifact", sid, "narration"],
    queryFn: () => getArtifact(sid, "narration"),
  });
  const music = useQuery({
    queryKey: ["artifact", sid, "music"],
    queryFn: () => getArtifact(sid, "music"),
  });

  if (narration.isLoading || music.isLoading) {
    return <div className="h-64 animate-pulse rounded-2xl bg-muted" />;
  }

  const tracks = buildAudioTracks(
    sid,
    (narration.data?.data as NarrationData | undefined) ?? null,
    (music.data?.data as MusicData | undefined) ?? null,
    // Version busts the browser cache: narration files keep fixed names across
    // re-runs, so without it the player replays the previous take.
    narration.data?.version,
  );

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-card px-8 py-12 text-center shadow-xs">
        <Music className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No audio generated yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stale && (
        <p className="text-xs text-destructive">
          This audio is stale — it predates your latest revision.
        </p>
      )}
      <AudioPlayer
        tracks={tracks}
        className="flex flex-col gap-4 rounded-2xl bg-card p-4 shadow-xs"
      >
        <AudioTrackList media="index" className="max-h-64 w-full rounded-xl border p-1" />
        <AudioPlayerControlBar variant="stacked">
          <AudioPlayerControlGroup>
            <AudioPlayerTimeDisplay />
            <AudioPlayerSeekBar />
            <AudioPlayerTimeDisplay remaining />
          </AudioPlayerControlGroup>
          <AudioPlayerControlGroup>
            <AudioPlayerSkipBack />
            <AudioPlayerPlay />
            <AudioPlayerSkipForward />
            <AudioPlayerVolume />
          </AudioPlayerControlGroup>
        </AudioPlayerControlBar>
      </AudioPlayer>
    </div>
  );
}
