// apps/web/src/content/blog/video-aspect-ratios-for-social-media.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";

function Body(): React.ReactElement {
  return (
    <>
      <p>
        Aspect ratio is the first production decision that is really a distribution decision. The
        same promo lives or dies by whether its shape matches where it plays: a widescreen video
        letterboxed into a TikTok feed surrenders most of the screen, and a vertical video on a
        website hero looks like a phone screen lost in a desert. Here is what each ratio is for,
        how the design changes between them, and the workflow that stops you from choosing at all.
      </p>

      <h2>The three shapes and their homes</h2>
      <table>
        <thead>
          <tr>
            <th>Ratio</th>
            <th>Shape</th>
            <th>Where it belongs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>16:9</strong>
            </td>
            <td>Widescreen</td>
            <td>YouTube, websites, presentations, TVs, most embeds</td>
          </tr>
          <tr>
            <td>
              <strong>9:16</strong>
            </td>
            <td>Vertical</td>
            <td>TikTok, Instagram Reels, YouTube Shorts, Stories</td>
          </tr>
          <tr>
            <td>
              <strong>1:1</strong>
            </td>
            <td>Square</td>
            <td>Feed placements that share space with text posts</td>
          </tr>
        </tbody>
      </table>
      <p>
        The pattern: <strong>16:9</strong> is for screens people sit in front of,{" "}
        <strong>9:16</strong> is for the phone held the way phones are actually held, and{" "}
        <strong>1:1</strong> is the compromise that occupies maximum feed height without committing
        to full vertical.
      </p>

      <h2>Vertical is not cropped widescreen</h2>
      <p>
        The most common aspect-ratio mistake is making one 16:9 master and cropping it three ways.
        Cropping changes composition blindly: subjects get beheaded, product shots lose the
        product, and text walks off the edge. The shapes want different designs, not the same
        design trimmed:
      </p>
      <ul>
        <li>
          <strong>Widescreen composes in scenes.</strong> There is room for context — a product in
          an environment, side-by-side comparisons, wide establishing shots.
        </li>
        <li>
          <strong>Vertical composes in subjects.</strong> One thing at a time, centered, large.
          Vertical is a close-up medium; a wide shot in 9:16 wastes the format.
        </li>
        <li>
          <strong>Square composes conservatively.</strong> Keep the action in the middle; square
          survives being effectively cropped from either direction.
        </li>
      </ul>

      <h2>Design rules that change with the shape</h2>
      <ul>
        <li>
          <strong>Text must be bigger than feels right</strong> in vertical — the video may be
          glanced at from a scrolling thumb, not studied. If a caption looks slightly oversized on
          your desktop preview, it is probably correct on a phone.
        </li>
        <li>
          <strong>Respect the UI overlays.</strong> Vertical platforms draw buttons, captions, and
          usernames over the bottom and right edges. Keep essential text and logos out of those
          zones or the platform will cover them.
        </li>
        <li>
          <strong>Captions are non-negotiable everywhere.</strong> A large share of feed viewing
          happens muted; captions are the narration those viewers get. (They also make your{" "}
          <Link href="/blog/ai-voiceover-for-product-videos">voiceover</Link> land twice.)
        </li>
        <li>
          <strong>Pacing tightens as the screen shrinks.</strong> A 60-second widescreen explainer
          might be a 30-second vertical cut — see{" "}
          <Link href="/blog/how-long-should-a-promo-video-be">how long a promo should be</Link> per
          placement.
        </li>
      </ul>

      <h2>Resolutions and export targets</h2>
      <p>
        Ratio and resolution travel together. The safe defaults in 2026 are still the full-HD
        family: <strong>1920×1080</strong> for 16:9, <strong>1080×1920</strong> for 9:16, and{" "}
        <strong>1080×1080</strong> for 1:1. Platforms transcode whatever you upload, and they are
        far kinder to a clean 1080p file than to an odd in-between size they must letterbox or
        crop. Going higher (4K) rarely helps a promo — feeds compress aggressively — while going
        lower shows up immediately as mush on modern phone screens. Frame rate follows the same
        logic: a steady 30fps reads as native everywhere a promo runs.
      </p>

      <h2>The mistakes that give it away</h2>
      <ul>
        <li>
          <strong>Letterboxing instead of reformatting.</strong> Black bars around a 16:9 video in
          a vertical feed tell the viewer this ad was made for somewhere else — and viewers treat
          out-of-place ads as skippable.
        </li>
        <li>
          <strong>Blind center-cropping.</strong> Automated crops decapitate subjects and slice
          product shots. If a crop is truly unavoidable, re-check every scene by eye.
        </li>
        <li>
          <strong>Desktop-sized text on a phone canvas.</strong> Preview the vertical cut on an
          actual phone before publishing; what is legible in a browser tab is often unreadable at
          arm&rsquo;s length.
        </li>
        <li>
          <strong>Forgetting the overlay zones.</strong> A CTA parked in the bottom fifth of a
          9:16 frame spends its life underneath the platform&rsquo;s own UI.
        </li>
      </ul>

      <h2>Which do you make first?</h2>
      <p>Decide by destination, not by habit:</p>
      <ol>
        <li>
          <strong>Selling on your website?</strong> 16:9 first — it embeds cleanly and doubles for
          YouTube and decks.
        </li>
        <li>
          <strong>Buying ads on Reels/TikTok/Shorts?</strong> 9:16 first, designed vertical from
          the start.
        </li>
        <li>
          <strong>Posting organically in mixed feeds?</strong> 1:1 or 9:16 depending on platform —
          square where posts share space with text, vertical where video is full-screen.
        </li>
      </ol>

      <h2>The workflow that ends the debate</h2>
      <p>
        Historically you chose one ratio because each additional version was another edit. That
        constraint is gone: with agent-based production the composition is regenerated per format
        rather than cropped, so each shape gets its own layout, caption placement, and pacing. On{" "}
        <Link href="/">UltraVora</Link> you pick widescreen, vertical, or square per render — the
        same approved script and brand can ship as a 16:9 site hero, a 9:16 ad, and a 1:1 feed post
        (the <Link href="/blog/how-to-make-a-promo-video-with-ai">start-to-finish guide</Link>{" "}
        covers the approval workflow).
      </p>
      <p>
        Treat aspect ratio like you treat length: a property of the placement, not of the idea.
        Make the message once, then render it in the shape each channel deserves —{" "}
        <Link href="/login">try all three from one prompt</Link> and compare them on your own
        phone.
      </p>
    </>
  );
}

export const post: BlogPost = {
  slug: "video-aspect-ratios-for-social-media",
  title: "16:9, 9:16 or 1:1? Video Aspect Ratios, Explained",
  description:
    "A no-nonsense guide to video aspect ratios for YouTube, TikTok, Reels, Shorts and the feed — which shape to pick, how the design changes, and when to make all three.",
  published: "2026-08-17",
  tags: ["aspect ratio", "social media", "video design"],
  readingMinutes: 4,
  related: [
    "how-long-should-a-promo-video-be",
    "ai-video-ads-for-small-business",
    "how-to-make-a-promo-video-with-ai",
  ],
  Body,
};
