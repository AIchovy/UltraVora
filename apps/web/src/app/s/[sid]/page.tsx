import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SessionPageClient } from "@/components/session-page-client";
import { getServerSession } from "@/lib/server-session";

// Private per-user workspace — never index (robots.txt also disallows /s/).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Page({
  params,
}: {
  params: Promise<{ sid: string }>;
}): Promise<React.ReactElement> {
  const { sid } = await params;
  const session = await getServerSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/s/${sid}`)}`);
  return <SessionPageClient sid={sid} />;
}
