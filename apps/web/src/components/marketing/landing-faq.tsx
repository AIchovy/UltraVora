import { ChevronDown } from "lucide-react";

const FAQS: { q: string; a: string }[] = [
  {
    q: "What is UltraVora?",
    a: "An AI video studio that turns a written prompt into a finished promo video. It researches your product, plans the creative, writes the script, records the voiceover, and renders the final cut. You review and approve along the way.",
  },
  {
    q: "What AI models does UltraVora use?",
    a: "Generation is powered by Google's Gemini model family: Gemini language models handle the research, creative brief, and script, and Gemini media models generate the visuals, voiceover, and music. Your prompts and uploaded content are processed by these third-party models to produce your video, and every prompt passes automated content moderation before generation starts.",
  },
  {
    q: "Do I need video editing experience?",
    a: "No. You describe what you want in plain language and give feedback the same way. UltraVora handles the editing, mixing, captions, and rendering.",
  },
  {
    q: "Can I change something I don't like?",
    a: "Yes. The pipeline pauses for your approval at key stages: the creative brief and the script. After the render you can ask for tweaks and re-render what changed.",
  },
  {
    q: "What formats do I get?",
    a: "Share-ready video in widescreen (16:9), vertical (9:16), or square (1:1), in lengths from 15 seconds up to three minutes, with captions included.",
  },
  {
    q: "What happens if I close the tab mid-render?",
    a: "Nothing is lost. Generation runs on our servers, not in your browser. Close the laptop, come back later, and your session picks up exactly where it left off.",
  },
  {
    q: "How do I sign in?",
    a: "With your Google account in one click, or with an email and password. New email accounts confirm with a short verification code we send you.",
  },
];

// Mirrors the visible FAQ 1:1 — schema that diverges from on-page content
// violates Google's structured-data guidelines.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((faq) => ({
    "@type": "Question",
    name: faq.q,
    acceptedAnswer: { "@type": "Answer", text: faq.a },
  })),
};

export function LandingFaq(): React.ReactElement {
  return (
    <section id="faq" tabIndex={-1} className="scroll-mt-20 border-t border-border/60 outline-none">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <div className="mx-auto w-full max-w-3xl px-6 py-20 md:py-24">
        <h2 className="text-center text-3xl font-semibold tracking-tight md:text-4xl">
          Frequently asked questions
        </h2>
        <div className="mt-10 divide-y divide-border/70 rounded-2xl border border-border/70 bg-card shadow-card">
          {FAQS.map((faq) => (
            <details key={faq.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg text-[15px] font-medium transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card [&::-webkit-details-marker]:hidden">
                {faq.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted-foreground group-open:animate-fade-in">
                {faq.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
