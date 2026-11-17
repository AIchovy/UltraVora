// apps/web/src/content/blog/promo-video-script-templates.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

function Body(): React.ReactElement {
  return (
    <>
      <p>
        A promo video is written before it is made. The script decides what the viewer feels in the
        first three seconds, what they understand by the middle, and what they do at the end — the
        visuals exist to serve it. This guide gives you the structure professionals reach for, the
        timing math that keeps scripts honest, and five fill-in-the-blank templates you can adapt
        in minutes.
      </p>

      <h2>The universal structure: hook, problem, product, proof, push</h2>
      <p>
        Almost every promo that works — from a 15-second ad to a 90-second launch film — walks the
        same five beats:
      </p>
      <ol>
        <li>
          <strong>Hook.</strong> Name a moment your audience recognizes, or show the result before
          the explanation. The product does not have to appear yet.
        </li>
        <li>
          <strong>Problem.</strong> One sentence of friction. Make it specific enough to sting.
        </li>
        <li>
          <strong>Product.</strong> Introduce the fix and the single message you chose for this
          video. One message — not the feature list.
        </li>
        <li>
          <strong>Proof.</strong> A demonstration, a number that is true, or a customer voice.
          Seeing beats claiming.
        </li>
        <li>
          <strong>Push.</strong> One call to action, stated plainly. &ldquo;Try it free&rdquo;
          outperforms three competing links.
        </li>
      </ol>
      <p>Here is how those beats spread across a 30-second cut:</p>
      <table>
        <thead>
          <tr>
            <th>Beat</th>
            <th>Time</th>
            <th>Spoken words (approx.)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Hook</td>
            <td>0–3s</td>
            <td>7–9</td>
          </tr>
          <tr>
            <td>Problem</td>
            <td>3–8s</td>
            <td>12–14</td>
          </tr>
          <tr>
            <td>Product</td>
            <td>8–18s</td>
            <td>24–28</td>
          </tr>
          <tr>
            <td>Proof</td>
            <td>18–25s</td>
            <td>16–18</td>
          </tr>
          <tr>
            <td>Push</td>
            <td>25–30s</td>
            <td>8–10</td>
          </tr>
        </tbody>
      </table>

      <h2>The timing math every script must obey</h2>
      <p>
        Natural narration runs near 150 words per minute — about 2.5 words per second. That single
        number keeps scripts from lying to you:
      </p>
      <ul>
        <li>
          <strong>15 seconds</strong> ≈ 35 spoken words
        </li>
        <li>
          <strong>30 seconds</strong> ≈ 75 spoken words
        </li>
        <li>
          <strong>60 seconds</strong> ≈ 150 spoken words
        </li>
        <li>
          <strong>90 seconds</strong> ≈ 220 spoken words
        </li>
      </ul>
      <p>
        Count your draft. If a &ldquo;30-second script&rdquo; is 110 words, it is a 45-second
        script wearing a disguise, and the edit will either rush the voiceover or cut your proof
        beat. (Choosing the length itself is its own decision — our guide on{" "}
        <Link href="/blog/how-long-should-a-promo-video-be">promo video length</Link> covers it.)
      </p>

      <h2>Five templates you can steal</h2>

      <h3>1. Problem → Agitate → Solve (the default for ads)</h3>
      <blockquote>
        <p>
          Still [painful task] by hand? / Every week it costs you [time or money], and it never
          gets easier. / [Product] does it in [timeframe] — [how, in one clause]. / Here&rsquo;s
          what that looks like. / Try [product] free at [site].
        </p>
      </blockquote>
      <p>
        Works because the viewer self-selects at the first line. Best at 15–30 seconds for paid
        social.
      </p>

      <h3>2. Before / After (show the delta)</h3>
      <blockquote>
        <p>
          This was [task] before [product]: [one ugly detail]. / This is after: [one clean result].
          / No [old requirement]. No [old requirement]. / Just [the outcome]. / See it yourself —
          [CTA].
        </p>
      </blockquote>
      <p>
        The contrast does the persuading, so keep both halves concrete. Strong for tools and
        physical products alike.
      </p>

      <h3>3. Three Things (feature-to-benefit)</h3>
      <blockquote>
        <p>
          Three reasons [audience] switch to [product]. / One: [feature] — so [benefit]. / Two:
          [feature] — so [benefit]. / Three: [feature] — so [benefit]. / [Product]. [Tagline].
          [CTA].
        </p>
      </blockquote>
      <p>
        The &ldquo;so&rdquo; is mandatory. A feature without its consequence is trivia. Fits 30–60
        seconds.
      </p>

      <h3>4. Founder Story (trust builder)</h3>
      <blockquote>
        <p>
          I built [product] because [honest frustration]. / Everything we tried [failed how]. / So
          we made [product] — [what it does differently]. / Today, [who uses it and for what]. /
          If that sounds like you, [CTA].
        </p>
      </blockquote>
      <p>
        Longer, warmer, best on landing pages and communities rather than cold ads. Sincerity
        survives AI narration surprisingly well when the writing is plain.
      </p>

      <h3>5. Social Proof First (lead with the crowd)</h3>
      <blockquote>
        <p>
          [Number that is true] [people/teams] use [product] to [outcome]. / Why? [The one
          message]. / [One concrete demonstration]. / Join them — [CTA].
        </p>
      </blockquote>
      <p>Only usable when the number is real and impressive to your audience — never invent it.</p>

      <h2>A hook bank to get unstuck</h2>
      <p>When the first line won&rsquo;t come, borrow a pattern and fill in your product:</p>
      <ul>
        <li>
          <strong>The recognizable moment:</strong> &ldquo;It&rsquo;s 4:55 on a Friday, and the
          report still isn&rsquo;t done.&rdquo;
        </li>
        <li>
          <strong>The result first:</strong> &ldquo;This video took one prompt to make.&rdquo;
        </li>
        <li>
          <strong>The forbidden question:</strong> &ldquo;What if you never scheduled a meeting by
          email again?&rdquo;
        </li>
        <li>
          <strong>The honest confession:</strong> &ldquo;We built this because we hated our own
          invoices.&rdquo;
        </li>
        <li>
          <strong>The countdown:</strong> &ldquo;Three things your landing page isn&rsquo;t
          telling people.&rdquo;
        </li>
      </ul>

      <h2>Mistakes that kill promo scripts</h2>
      <ul>
        <li>
          <strong>Cramming.</strong> Two messages means zero messages. Cut until one remains.
        </li>
        <li>
          <strong>Starting with the logo.</strong> The hook earns the logo; the logo does not earn
          the hook.
        </li>
        <li>
          <strong>Writing for the eye, not the ear.</strong> Long clauses read fine and sound
          terrible. Short sentences. Contractions. Breathing room. More in our{" "}
          <Link href="/blog/ai-voiceover-for-product-videos">AI voiceover guide</Link>.
        </li>
        <li>
          <strong>Multiple CTAs.</strong> Pick the one action that matters and repeat nothing else.
        </li>
      </ul>

      <h2>From template to finished video</h2>
      <p>
        A script on paper still needs scenes, voice, music, captions, and timing. That production
        step is exactly what AI now does well: on <Link href="/">UltraVora</Link>, the agent drafts
        the script for you from a prompt, pauses for your approval, and you can rewrite any line
        before a single frame renders — the workflow in our{" "}
        <Link href="/blog/how-to-make-a-promo-video-with-ai">start-to-finish guide</Link>. Paste
        your favorite template into the prompt, or let the agent draft and then hold it to the
        structure above. Either way, the five beats are the test:{" "}
        <Link href="/login">write one script today</Link> and see it performed in minutes.
      </p>
    </>
  );
}

export const post: BlogPost = {
  slug: "promo-video-script-templates",
  title: "Promo Video Scripts: Structure, Timing, and 5 Templates",
  description:
    "How to write a promo video script that sells: the five-beat structure, second-by-second timing math, and five fill-in-the-blank templates for 15 to 90 second videos.",
  published: "2026-08-17",
  tags: ["script writing", "promo video", "templates"],
  readingMinutes: 4,
  related: [
    "how-to-make-a-promo-video-with-ai",
    "how-long-should-a-promo-video-be",
    "ai-voiceover-for-product-videos",
  ],
  Body,
};
