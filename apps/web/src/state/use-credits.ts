"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCredits } from "@/lib/api-client";

export function useCredits() {
  return useQuery({ queryKey: ["credits"], queryFn: getCredits });
}

/** Returns a function that refetches the credits balance (call after a purchase). */
export function useRefreshCredits(): () => void {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["credits"] });
}
