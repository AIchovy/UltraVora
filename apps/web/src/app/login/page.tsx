import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/login-card";
import { getServerSession } from "@/lib/server-session";
import { safeNext } from "@/lib/safe-next";

export const metadata: Metadata = {
  title: "Log in — UltraVora",
  description: "Log in to UltraVora to turn a prompt into a finished promo video.",
  alternates: { canonical: "/login" },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<React.ReactElement> {
  const next = safeNext((await searchParams).next);
  const session = await getServerSession();
  if (session) redirect(next);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <LoginCard callbackURL={next} />
    </main>
  );
}
