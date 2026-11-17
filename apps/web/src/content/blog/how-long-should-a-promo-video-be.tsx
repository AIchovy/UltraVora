// apps/web/src/content/blog/how-long-should-a-promo-video-be.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

function Body(): React.ReactElement {
  return (
    <>
      <p>
        The short answer: as long as the job requires and not one second longer. A promo video that
        interrupts a feed has a different job than one that greets a visitor who already clicked
        your ad — so they should not be the same length. Here is the placement-by-placement
        guidance, the reasoning behind it, and the word budgets that keep each length honest.
      </p>

      <h2>The quick reference</h2>
      <table>
        <thead>
          <tr>
            <th>Where it runs</th>
            <th>Length</th>
            <th>The job</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Paid social ad (feed or stories)</td>
            <td>15–30s</td>
            <td>Stop the scroll, land one message, one CTA</td>
          </tr>
          <tr>
            <td>Organic social post</td>
            <td>15–45s</td>
            <td>Earn a follow or a share with one idea</td>
          </tr>
          <tr>
            <td>Landing page hero</td>
            <td>30–60s</td>
            <td>Confirm the visitor&rsquo;s decision to care</td>
          </tr>
          <tr>
            <td>Product demo / explainer</td>
            <td>60–90s</td>
            <td>Show the workflow, answer &ldquo;how does it work?&rdquo;</td>
          </tr>
          <tr>
            <td>Launch film / founder story</td>
            <td>90s–3min</td>
            <td>Build belief for an audience that opted in</td>
          </tr>
        </tbody>
      </table>

      <h2>Length follows attention, and attention follows intent</h2>
      <p>
        The single principle underneath every row of that table: match the video&rsquo;s length to
        how much attention the viewer has already agreed to give you.
      </p>
      <ul>
        <li>
          <strong>Interruption contexts</strong> (ads, feeds): you have borrowed attention. The
          viewer did not ask for this. Fifteen to thirty seconds is the respectful maximum, and the
          first three seconds decide everything — front-load the reason to stay.
        </li>
        <li>
          <strong>Consideration contexts</strong> (your website, a docs page): the viewer clicked
          something to get here. Thirty to ninety seconds is welcome if every second earns its
          place.
        </li>
        <li>
          <strong>Committed contexts</strong> (a launch event, an email to fans, a sales call
          follow-up): minutes are fine. These viewers want depth, not brevity.
        </li>
      </ul>

      <h2>The word budget test</h2>
      <p>
        Narration runs at roughly 150 words per minute. Before debating seconds, count words in
        the script:
      </p>
      <ul>
        <li>15 seconds ≈ 35 words — one idea, stated once</li>
        <li>30 seconds ≈ 75 words — one idea, with one proof</li>
        <li>60 seconds ≈ 150 words — one idea, proof, and a short tour</li>
        <li>90 seconds ≈ 220 words — a full narrative arc</li>
      </ul>
      <p>
        If your message will not fit the budget, the fix is almost never a longer video — it is a
        smaller message. Our{" "}
        <Link href="/blog/promo-video-script-templates">script templates</Link> are built around
        those budgets, beat by beat.
      </p>

      <h2>A useful heuristic: one message per thirty seconds</h2>
      <p>
        Viewers reliably retain about one idea per half-minute of promo. A 30-second ad carries one
        message. A 60-second explainer carries one message plus how-it-works. A 3-minute launch
        film carries a story — which is still, structurally, one message wearing different outfits.
        When a draft feels long, it is usually not too many seconds; it is too many messages
        sharing them.
      </p>

      <h2>Cutting a 60 down to a 30 (without breaking it)</h2>
      <p>
        The most common real-world task is not writing a fresh short script — it is shrinking an
        existing one. Three moves preserve the argument while halving the runtime:
      </p>
      <ol>
        <li>
          <strong>Cut setups, keep payoffs.</strong> Long cuts explain the problem and then show
          the fix; short cuts open on the fix and let the viewer infer the problem. The hook
          becomes the payoff line.
        </li>
        <li>
          <strong>Collapse proof to its strongest single item.</strong> Three testimonials become
          one; a feature tour becomes the one feature people actually buy.
        </li>
        <li>
          <strong>Never speed up the read.</strong> A rushed voiceover is the audible version of
          fine print. If the words don&rsquo;t fit at a natural pace, remove words — not pauses.
        </li>
      </ol>
      <p>
        Run the mute test on the short cut afterwards: with captions on and sound off, the
        30-second version should still land its one message. If it only works with narration, the
        cut leaned on speed instead of selection.
      </p>

      <h2>When longer genuinely wins</h2>
      <p>Long videos are not a failure state. They win when the viewer&rsquo;s question is big:</p>
      <ul>
        <li>
          <strong>Demos for considered purchases.</strong> Nobody buys week-long-implementation
          software off a 15-second clip. A 90-second guided tour that honestly shows the product
          beats a montage.
        </li>
        <li>
          <strong>Founder stories.</strong> Trust takes narrative time. These run 1–3 minutes and
          belong on pages and channels where people chose to be.
        </li>
        <li>
          <strong>Testimonial compilations.</strong> Three customers at 25 seconds each is 75
          well-spent seconds.
        </li>
      </ul>

      <h2>Stop choosing — make the set</h2>
      <p>
        The practical resolution of the length debate is that you no longer have to pick one.
        Production used to be expensive enough that teams made a single 60-second video and forced
        it everywhere: too long for ads, too shallow for the demo. With AI production the marginal
        cut is cheap — on <Link href="/">UltraVora</Link> you can render anywhere from 15 seconds
        to three minutes, in widescreen, vertical, or square (see{" "}
        <Link href="/blog/video-aspect-ratios-for-social-media">which aspect ratio to use where</Link>
        ), so the sane workflow is a master cut plus purpose-sized versions: a 60-second hero for
        the site, a 30-second ad, a 15-second teaser.
      </p>

      <h2>The honest checklist</h2>
      <ul>
        <li>Where will this video actually run? Length follows placement.</li>
        <li>Does the script fit the word budget without rushing?</li>
        <li>Is there exactly one message per 30 seconds?</li>
        <li>Would you watch to the end if it were not your product?</li>
        <li>Could the same script ship as a shorter cut for borrowed-attention channels?</li>
      </ul>
      <p>
        If you want to feel the difference rather than theorize about it, generate the same promo
        at 15, 30, and 60 seconds and watch them back to back — the{" "}
        <Link href="/blog/how-to-make-a-promo-video-with-ai">full workflow guide</Link> shows how,
        and a <Link href="/login">free session</Link> is enough to run the experiment on your own
        product.
      </p>
    </>
  );
}

export const post: BlogPost = {
  slug: "how-long-should-a-promo-video-be",
  title: "How Long Should a Promo Video Be?",
  description:
    "The right promo video length for every placement — 15, 30, 60 seconds or longer — with word budgets, attention rules, and when a longer video genuinely wins.",
  published: "2026-08-17",
  tags: ["promo video", "video length", "strategy"],
  readingMinutes: 4,
  related: [
    "promo-video-script-templates",
    "video-aspect-ratios-for-social-media",
    "how-to-make-a-promo-video-with-ai",
  ],
  Body,
};
