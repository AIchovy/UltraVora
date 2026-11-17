// apps/web/src/components/marketing/legal-article.tsx
import { LandingHeader } from "./landing-header";
import { LandingFooter } from "./landing-footer";

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  afterBullets?: string[];
}

export interface LegalDoc {
  title: string;
  effectiveDate: string;
  intro: string[];
  sections: LegalSection[];
}

const CONTACT_EMAIL = "support@ultra-vora.com";

// Content is plain text; the only inline markup we ever need is making the
// support address clickable wherever it appears.
function withEmailLink(text: string): React.ReactNode {
  if (!text.includes(CONTACT_EMAIL)) return text;
  const parts = text.split(CONTACT_EMAIL);
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <a key={i} href={`mailto:${CONTACT_EMAIL}`} className="underline hover:text-foreground">
            {CONTACT_EMAIL}
          </a>,
          part,
        ],
  );
}

/** Shared prose layout for /privacy and /terms — same chrome as the marketing pages. */
export function LegalArticle({ doc }: { doc: LegalDoc }): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingHeader />
      <main>
        <article className="mx-auto w-full max-w-3xl px-6 py-16 md:py-20">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{doc.title}</h1>
          <p className="mt-3 text-sm text-muted-foreground">Effective {doc.effectiveDate}</p>
          {doc.intro.map((p) => (
            <p key={p.slice(0, 40)} className="mt-6 text-[15px] leading-relaxed text-muted-foreground">
              {withEmailLink(p)}
            </p>
          ))}
          {doc.sections.map((s) => (
            <section key={s.heading} className="mt-10">
              <h2 className="text-xl font-semibold tracking-tight">{s.heading}</h2>
              {s.paragraphs.map((p) => (
                <p key={p.slice(0, 40)} className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                  {withEmailLink(p)}
                </p>
              ))}
              {s.bullets && (
                <ul className="mt-3 list-disc space-y-2 pl-6 text-[15px] leading-relaxed text-muted-foreground">
                  {s.bullets.map((b) => (
                    <li key={b.slice(0, 40)}>{withEmailLink(b)}</li>
                  ))}
                </ul>
              )}
              {s.afterBullets?.map((p) => (
                <p key={p.slice(0, 40)} className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                  {withEmailLink(p)}
                </p>
              ))}
            </section>
          ))}
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
