// apps/web/src/content/blog/turn-your-website-into-a-video.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

function Body(): React.ReactElement {
  return (
    <>
      <p>
        Your landing page already did the hard work. Somebody agonized over the headline, chose the
        product shots, wrote the feature list, and collected the testimonials. That page is a
        complete sales argument — it just doesn&rsquo;t move. Turning a website into a promo video
        is the fastest path from &ldquo;we should have a video&rdquo; to a finished cut, because
        the raw material already exists at one URL.
      </p>

      <h2>Why a URL beats a blank prompt</h2>
      <p>
        Ask a generic AI tool for &ldquo;a promo video for a project management app&rdquo; and you
        get generic results — stock gradients, vague claims, nobody&rsquo;s product in particular.
        Point an AI video agent at your actual website and the difference is immediate, because the
        source material is specific:
      </p>
      <ul>
        <li>
          <strong>Positioning:</strong> your headline and subhead say what you do and for whom —
          the video inherits the message you already validated.
        </li>
        <li>
          <strong>Features and proof:</strong> the benefits section becomes scene candidates; real
          numbers and testimonials become the proof beat.
        </li>
        <li>
          <strong>Brand:</strong> product screenshots, photography, and logos come from the page,
          so the video looks like you rather than like a template.
        </li>
        <li>
          <strong>Tone:</strong> playful copy produces a playful script; enterprise copy produces a
          steadier one.
        </li>
      </ul>
      <p>
        This is why <Link href="/">UltraVora</Link> begins every session with a research phase: it
        reads the pages you point it at, pulls the images worth keeping, and drafts a creative
        brief grounded in what your site actually says — not what a template assumes.
      </p>

      <h2>The workflow, end to end</h2>
      <ol>
        <li>
          <strong>Give the URL and the destination.</strong> &ldquo;Make a 30-second vertical promo
          from glowmug.com for Instagram ads&rdquo; is a complete instruction. Add the audience and
          the one message if you want tighter control from the first draft.
        </li>
        <li>
          <strong>Review the brief.</strong> The agent proposes the message, tone, and visual
          direction it found. This is where you correct emphasis — &ldquo;lead with the
          two-hour heat retention, not the colors.&rdquo;
        </li>
        <li>
          <strong>Curate the source images.</strong> Research casts a wide net. Drop the outdated
          screenshot and the low-resolution logo; keep the hero shots. A minute of curation here
          saves a re-render later.
        </li>
        <li>
          <strong>Approve the script</strong> — read it aloud, check the claims, confirm the CTA.
          (The <Link href="/blog/promo-video-script-templates">five-beat structure</Link> applies
          here exactly as if you had written it yourself.)
        </li>
        <li>
          <strong>Render and iterate.</strong> Watch the cut, ask for specific tweaks, publish.
        </li>
      </ol>

      <h2>Directing the result: what to specify, what to delegate</h2>
      <p>
        The failure mode of website-to-video is under-direction: paste URL, accept everything,
        publish a video that is accurate but aimless. The fix is not more effort — it is three
        sentences of intent:
      </p>
      <ul>
        <li>
          <strong>Specify</strong> the audience, the single message, and where the video will run.
          Placement drives length and format — a{" "}
          <Link href="/blog/how-long-should-a-promo-video-be">15-second vertical ad</Link> and a
          60-second homepage hero should not be the same cut.
        </li>
        <li>
          <strong>Delegate</strong> scene composition, motion, music, captions, and timing. This is
          precisely the work the agent does faster and more consistently than a human on a
          deadline.
        </li>
      </ul>

      <h2>Three checks before you publish</h2>
      <ol>
        <li>
          <strong>Claims:</strong> everything spoken or shown should be as true as the page it came
          from — and your page may have stale numbers worth fixing anyway.
        </li>
        <li>
          <strong>Brand:</strong> colors, product visuals, and voice should feel continuous with
          the site, because viewers will often see both within a minute of each other.
        </li>
        <li>
          <strong>The mute test:</strong> watch it silent. Most feed viewers will. If the captions
          and visuals alone carry the message, you are safe.
        </li>
      </ol>

      <h2>What if the site itself is thin?</h2>
      <p>
        A one-screen landing page with three sentences and a waitlist form still works as a source
        — it just moves more weight onto your prompt. State the audience and the one message
        explicitly, and attach whatever the page lacks: product screenshots, a spec sheet, even a
        paragraph of positioning you have never published. The research phase treats uploads and
        URLs the same way, so the brief comes back grounded in the fuller picture rather than the
        sparse page. Teams often discover the exercise doubles as landing-page feedback: whatever
        the agent could not find is usually what human visitors are missing too.
      </p>

      <h2>Where teams use it first</h2>
      <ul>
        <li>
          <strong>The homepage itself.</strong> The video version of the page, embedded above the
          fold, for visitors who would rather watch than read.
        </li>
        <li>
          <strong>Paid social tests.</strong> Spin three angles from the same URL — problem-first,
          demo-first, proof-first — and let the ad platform tell you which message wins. The{" "}
          <Link href="/blog/ai-video-ads-for-small-business">small-business ads playbook</Link>{" "}
          covers this cadence.
        </li>
        <li>
          <strong>Launches.</strong> Product Hunt, app stores, and announcement posts all want a
          video, on the same deadline, in different shapes. One research pass feeds all of them —
          including the <Link href="/blog/product-demo-video-without-a-film-crew">demo video</Link>{" "}
          your docs page has been missing.
        </li>
      </ul>

      <h2>Try it on your own page</h2>
      <p>
        The whole promise fits in one sentence: the pitch already exists at your URL, and the
        production is now the easy part. Paste your website into a{" "}
        <Link href="/login">free UltraVora session</Link>, approve the brief and the script, and
        compare the result with what an agency quote would have cost you — or browse the{" "}
        <Link href="/plaza">Product Plaza</Link> first to see what other teams shipped from a
        single link.
      </p>
    </>
  );
}

export const post: BlogPost = {
  slug: "turn-your-website-into-a-video",
  title: "Turn Your Website into a Promo Video",
  description:
    "Your landing page already contains the pitch. How AI turns a URL into a finished promo video — message, visuals, voiceover and all — and how to direct the result.",
  published: "2026-08-17",
  tags: ["website to video", "AI video", "workflow"],
  readingMinutes: 4,
  related: [
    "how-to-make-a-promo-video-with-ai",
    "product-demo-video-without-a-film-crew",
    "ai-video-ads-for-small-business",
  ],
  Body,
};
