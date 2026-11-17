"use client";
import { useQuery } from "@tanstack/react-query";
import { getSession } from "@/lib/api-client";
import { useSessionStream } from "./use-session-stream.js";

export function useSession(sid: string) {
  const stream = useSessionStream(sid);
  const session = useQuery({
    queryKey: ["session", sid],
    queryFn: () => getSession(sid),
  });
  return { stream, session };
}
