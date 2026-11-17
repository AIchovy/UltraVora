import { FeatureShowcase } from "./showcase/feature-showcase";
import { ResearchAnim } from "./showcase/research-anim";
import { BriefAnim } from "./showcase/brief-anim";
import { ScriptTimelineAnim } from "./showcase/script-timeline-anim";
import { RenderAnim } from "./showcase/render-anim";

export function LandingFeatures(): React.ReactElement {
  return (
    <section
      id="features"
      tabIndex={-1}
      className="scroll-mt-20 border-t border-border/60 bg-muted/40 outline-none"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-20 md:py-24">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            One AI agent, from prompt to final cut.
          </h2>
          <p className="mt-3 text-muted-foreground">
            The UltraVora agent does what a production team does, end to end: it studies your
            product, shapes the creative, writes and voices the script, and renders the final
            video. You direct and approve along the way.
          </p>
        </div>

        <div className="mt-16 space-y-20 md:mt-20 md:space-y-28">
          <FeatureShowcase
            layout="text-left"
            title="It studies your product first"
            body="Before writing a line, UltraVora digs into your product, your audience, and what actually makes people buy, so the video sells the right thing."
            visual={<ResearchAnim />}
          />
          <FeatureShowcase
            layout="text-right"
            title="A creative brief you approve"
            body="Mood, palette, and pacing arrive as a direction you can sign off on. Approve it, or ask for another take, before anything renders."
            visual={<BriefAnim />}
          />
          <FeatureShowcase
            layout="full"
            title="Scene by scene, on a timeline"
            body="Every shot, caption, and beat is laid out on a timeline you can read at a glance. Revise a line and the cut moves with it."
            visual={<ScriptTimelineAnim />}
          />
          <FeatureShowcase
            layout="text-left"
            title="Voiceover, then the final cut"
            body="A studio-quality voiceover is timed to the script, then footage, music, and captions compose into a share-ready video, widescreen or vertical."
            visual={<RenderAnim />}
          />
        </div>
      </div>
    </section>
  );
}
