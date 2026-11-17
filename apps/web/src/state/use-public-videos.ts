"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicVideoSort, PublicVideoSummary } from "@/lib/api-types";
import { getPublicVideo, likeVideo, listPublicVideos, unlikeVideo } from "@/lib/api-client";

export function usePublicVideos(sort: PublicVideoSort, initialData?: PublicVideoSummary[]) {
  return useQuery({
    queryKey: ["public-videos", sort],
    queryFn: () => listPublicVideos(sort),
    // Server components pass the list they already fetched so the first HTML
    // paint (and crawlers) see real cards; the query refetches when stale.
    initialData,
  });
}

export function usePublicVideo(sid: string, initialData?: PublicVideoSummary) {
  return useQuery({
    queryKey: ["public-video", sid],
    queryFn: () => getPublicVideo(sid),
    initialData,
  });
}

/**
 * Toggle a like. Pass the CURRENT liked state; the mutation flips it. Optimistic
 * across every cached public-videos list and the single-video cache.
 */
export function useLikeVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sid, liked }: { sid: string; liked: boolean }) =>
      liked ? unlikeVideo(sid) : likeVideo(sid),
    onMutate: async ({ sid, liked }) => {
      await qc.cancelQueries({ queryKey: ["public-videos"] });
      const delta = liked ? -1 : 1;
      const patch = (v: PublicVideoSummary): PublicVideoSummary =>
        v.sid === sid ? { ...v, likedByMe: !liked, likeCount: Math.max(0, v.likeCount + delta) } : v;
      qc.setQueriesData<PublicVideoSummary[]>({ queryKey: ["public-videos"] }, (old) =>
        old ? old.map(patch) : old,
      );
      qc.setQueryData<PublicVideoSummary | null>(["public-video", sid], (old) => (old ? patch(old) : old));
    },
    onSettled: (_data, _err, { sid }) => {
      void qc.invalidateQueries({ queryKey: ["public-videos"] });
      void qc.invalidateQueries({ queryKey: ["public-video", sid] });
    },
  });
}
