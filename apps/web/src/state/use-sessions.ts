"use client";
import { useQuery } from "@tanstack/react-query";
import { listSessions } from "@/lib/api-client";

/**
 * Sessions for the sidebar. The list is otherwise only refetched on
 * create/delete, so while any task is still generating (status "running") we
 * poll — that's what lets the sidebar's in-progress spinner turn itself on and
 * back off as generation finishes. Polling stops (returns false) once nothing
 * is running, so an idle sidebar makes no requests.
 */
export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "running") ? 4000 : false,
  });
}
