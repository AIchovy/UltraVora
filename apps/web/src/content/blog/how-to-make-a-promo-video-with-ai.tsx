// apps/web/src/content/blog/how-to-make-a-promo-video-with-ai.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

function Body(): React.ReactElement {
  return (
    <>
      <p>
        Making a promo video used to mean a brief, a quote, a shoot, and three weeks of edits. The
        newest AI video tools collapse that into a conversation: you describe the product, the
        system does the production, and you approve the work at the moments that matter. This guide
        walks through the whole process — from writing the first prompt to publishing the final cut
        — and shows where human judgment still earns its keep.
      </p>

      <h2>What &ldquo;making a video with AI&rdquo; actually means now</h2>
      <p>
        Early AI video tools generated a few seconds of dreamy footage from a text prompt. That is
        not a promo video. A promo video is an argument: it has a message, a structure, a voice,
        and a call to action. Modern AI video <em>agents</em> treat it that way. Instead of one
        model guessing at pixels, an agent runs a pipeline that looks a lot like a small studio:
      </p>
      <ul>
        <li>
          <strong>Research.</strong> It reads your website, product pages, and anything you upload,
          and works out what the product is, who it is for, and what proof exists.
        </li>
        <li>
          <strong>Creative brief.</strong> It proposes a direction — the one message, the tone, the
          visual style, which assets to use.
        </li>
        <li>
          <strong>Script.</strong> It writes the narration and scene plan, timed to the length you
          asked for.
        </li>
        <li>
          <strong>Voiceover and music.</strong> It records an AI voice, picks music, and mixes
          them.
        </li>
        <li>
          <strong>Compose and render.</strong> It animates scenes, adds captions, and renders the
          finished file.
        </li>
      </ul>
      <p>
        The important part is the review gates between stages. On{" "}
        <Link href="/">UltraVora</Link>, the pipeline pauses twice — at the brief and at the script
        — so you approve the thinking before any rendering happens. Fixing a sentence in a script
        costs seconds; fixing it after the render costs a re-render.
      </p>

      <h2>Step 1: Write the prompt like a one-paragraph brief</h2>
      <p>
        The prompt is the highest-leverage minute of the whole process. You do not need to be a
        copywriter; you need to make five decisions and state them plainly:
      </p>
      <ol>
        <li>
          <strong>Product:</strong> what it is, in one sentence. A URL helps more than adjectives —
          the agent will research it.
        </li>
        <li>
          <strong>Audience:</strong> who should stop scrolling. &ldquo;Small e-commerce
          brands&rdquo; beats &ldquo;everyone.&rdquo;
        </li>
        <li>
          <strong>The one message:</strong> the single idea a viewer should remember. One. Videos
          die from carrying three.
        </li>
        <li>
          <strong>Tone:</strong> two or three words — &ldquo;warm and unhurried,&rdquo;
          &ldquo;punchy and confident.&rdquo;
        </li>
        <li>
          <strong>Length and destination:</strong> a 15-second vertical ad and a 60-second homepage
          video are different creatures. See our guide on{" "}
          <Link href="/blog/how-long-should-a-promo-video-be">how long a promo video should be</Link>{" "}
          if you are unsure.
        </li>
      </ol>
      <p>A prompt that contains all five, in plain language, is enough:</p>
      <blockquote>
        <p>
          &ldquo;A 30-second promo for glowmug.com — a ceramic mug that keeps coffee at temperature
          for two hours. Audience: remote workers who sip slowly. Message: your coffee stays
          perfect from the first call to the last. Tone: warm morning light, calm confidence.
          Vertical, for Instagram Reels.&rdquo;
        </p>
      </blockquote>

      <h2>Step 2: Read the brief like an editor, not a fan</h2>
      <p>
        The creative brief is where the agent shows its understanding of your product. Check three
        things before approving:
      </p>
      <ul>
        <li>
          <strong>Positioning.</strong> Did it lead with the thing your customers actually buy you
          for? If it latched onto a minor feature, say so in a sentence and let it revise.
        </li>
        <li>
          <strong>Claims.</strong> Anything that reads like a number or a guarantee should be true.
          You are publishing this.
        </li>
        <li>
          <strong>Assets.</strong> Curate the images it researched — drop the outdated screenshot,
          keep the good product shots. Bad source assets are the most common cause of a
          &ldquo;that&rsquo;s not my brand&rdquo; final cut.
        </li>
      </ul>

      <h2>Step 3: Approve the script — the contract for the edit</h2>
      <p>
        Everything downstream — voiceover, scene timing, captions — is built from the script, so
        this is the gate worth the most attention. Two practical checks:
      </p>
      <p>
        <strong>Read it aloud.</strong> Narration runs at roughly 150 words per minute, about 2.5
        words per second. A 30-second video holds 70–80 spoken words. If the script feels crowded
        read aloud, it will feel worse with visuals competing for attention.
      </p>
      <p>
        <strong>Judge the first line only on one question:</strong> would a stranger keep watching?
        The hook does not need to mention your product; it needs to name a moment your audience
        recognizes. Our{" "}
        <Link href="/blog/promo-video-script-templates">promo script templates</Link> break down
        five hook patterns that consistently work.
      </p>

      <h2>Step 4: Voice, music, captions</h2>
      <p>
        The voice is your brand&rsquo;s sound — audition a few before settling. A calm, lower-pitch
        read suits premium products; a brighter, quicker read suits consumer apps. (More on this in{" "}
        <Link href="/blog/ai-voiceover-for-product-videos">choosing an AI voiceover</Link>.) Keep
        captions on regardless: much of social video is watched muted, and captions are the only
        narration those viewers get.
      </p>

      <h2>Step 5: Render, review, and ask for tweaks</h2>
      <p>
        Rendering happens on the server — on UltraVora you can close the laptop and the job keeps
        going. When the cut is ready, review it like a viewer first (does it hold attention?) and
        like an owner second (logo, colors, claims, CTA). Then ask for specific tweaks:
        &ldquo;slow the second scene,&rdquo; &ldquo;swap the music for something quieter,&rdquo;
        &ldquo;end on the product shot.&rdquo; Targeted notes re-render what changed instead of
        starting over.
      </p>

      <h2>What it costs and how long it takes</h2>
      <p>
        The economics are the quiet revolution. On UltraVora&rsquo;s{" "}
        <Link href="/pricing">usage-based pricing</Link>, a typical one-minute promo runs about 400
        credits — roughly four dollars — and a first cut arrives in minutes, not weeks. That
        changes behavior: you stop treating a promo video as a quarterly capital project and start
        treating it like a draft you iterate on.
      </p>

      <h2>A 60-second pre-flight checklist</h2>
      <ul>
        <li>One product, one audience, one message, one CTA.</li>
        <li>Length matches the placement.</li>
        <li>Brief approved with correct positioning and true claims.</li>
        <li>Script survives being read aloud.</li>
        <li>Voice matches the brand; captions on.</li>
        <li>Final cut checked on the device where it will actually run — usually a phone.</li>
      </ul>
      <p>
        The best way to learn the workflow is to run it once on your own product. Browse real
        examples in the <Link href="/plaza">Product Plaza</Link> to calibrate what finished results
        look like, then <Link href="/login">start with a free session</Link> — the first draft will
        teach you more than any guide.
      </p>
    </>
  );
}

export const post: BlogPost = {
  slug: "how-to-make-a-promo-video-with-ai",
  title: "How to Make a Promo Video with AI (From One Prompt)",
  description:
    "A practical, step-by-step guide to making a promo video with AI: writing the prompt, shaping the creative brief, approving the script, and rendering the final cut.",
  published: "2026-08-17",
  tags: ["AI video", "promo video", "how-to"],
  readingMinutes: 5,
  related: [
    "promo-video-script-templates",
    "how-long-should-a-promo-video-be",
    "turn-your-website-into-a-video",
  ],
  Body,
};
