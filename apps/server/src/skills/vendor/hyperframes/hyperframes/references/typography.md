# Typography

The compiler embeds supported fonts — just write `font-family` in CSS.

## Banned

Training-data defaults that every LLM reaches for. These produce monoculture across compositions.

Inter, Roboto, Open Sans, Noto Sans, Arimo, Lato, Source Sans, PT Sans, Nunito, Poppins, Outfit, Sora, Playfair Display, Cormorant Garamond, Bodoni Moda, EB Garamond, Cinzel, Prata, Syne

**Syne in particular** is the most overused "distinctive" display font. It is an instant AI design tell.

## Guardrails

You know these rules but you violate them. Stop.

- **Don't pair two sans-serifs.** You do this constantly — one for headlines, one for body. Cross the boundary: serif + sans, or sans + mono.
- **One expressive font per scene.** You pick two interesting fonts trying to make it "better." One performs, one recedes.
- **Weight contrast must be extreme.** You default to 400 vs 700. Video needs 300 vs 900. The difference must be visible in motion at a glance.
- **Video sizes, not web sizes.** Body: 20px minimum. Headlines: 60px+. Data labels: 16px. You will try to use 14px. Don't.

## What You Don't Do Without Being Told

- **Tension should mean something.** Don't pattern-match pairings. Ask WHY these two fonts disagree. The pairing should embody the content's contradiction — mechanical vs human, public vs private, institutional vs personal. If you can't articulate the tension, it's arbitrary.
- **Register switching.** Assign different fonts to different communicative modes — one voice for statements, another for data, another for attribution. Not hierarchy on a page. Voices in a conversation.
- **Tension can live inside a single font.** A font that looks familiar but is secretly strange creates tension with the viewer's expectations, not with another font.
- **One variable changed = dramatic contrast.** Same letterforms, monospaced vs proportional. Same family at different optical sizes. Changing only rhythm while everything else stays constant.
- **Double personality works.** Two expressive fonts can coexist if they share an attitude (both irreverent, both precise) even when their forms are completely different.
- **Time is hierarchy.** The first element to appear is the most important. In video, sequence replaces position.
- **Motion is typography.** How a word enters carries as much meaning as the font. A 0.1s slam vs a 2s fade — same font, completely different message.
- **Fixed reading time.** 3 seconds on screen = must be readable in 2. Fewer words, larger type.
- **Tracking tighter than web.** -0.03em to -0.05em on display sizes. Video encoding compresses letter detail.

## Finding Fonts

Don't default to what you know. If the content is luxury, a grotesque sans might create more tension than the expected Didone serif. Decide the register first, then search.

There is no shell in this environment, so you can't query the Google Fonts metadata live — draw on your knowledge of the Google Fonts library instead, deliberately reaching past your first-recall names (first recall = training-data default = monoculture, and the most-recalled ones are banned above).

Shop across five categories: **trending sans, trending serif, monospace, impact/condensed, script/handwriting**. Favor newer, less-common families over the perennial top of the popularity charts, and cross classification boundaries when pairing (sans + serif, sans + mono, condensed + wide).

## Selection Thinking

Don't pick fonts by category reflex (editorial → serif, tech → mono, modern → geometric sans). That's pattern matching, not design.

1. **Name the register.** What voice is the content speaking in? Institutional authority? Personal confession? Technical precision? Casual irreverence? The register narrows the field more than the category.
2. **Think physically.** Imagine the font as a physical object the brand could ship — a museum exhibit caption, a hand-painted shop sign, a 1970s mainframe terminal manual, a fabric label inside a coat, a children's book printed on cheap newsprint, a tax form. Whichever physical object fits the register is pointing at the right _kind_ of typeface.
3. **Reject your first instinct.** The first font that feels right is usually your training-data default for that register. If you picked it last time too, find something else.
4. **Cross-check the assumption.** An editorial brief does NOT need a serif. A technical brief does NOT need a sans. A children's product does NOT need a rounded display font. The most distinctive choice often contradicts the category expectation.

## Similar-Font Pairing

Never pair two fonts that are similar but not identical — two geometric sans-serifs, two transitional serifs, two humanist sans. They create visual friction without clear hierarchy. The viewer senses something is "off" but can't articulate it. Either use one font at two weights, or pair fonts that contrast on multiple axes: serif + sans, condensed + wide, geometric + humanist.

## Dark Backgrounds

Light text on dark backgrounds creates two optical illusions you need to compensate for:

- **Increased apparent weight.** Light-on-dark reads heavier than dark-on-light at the same `font-weight`. Use 350 instead of 400 for body text. Headlines are less affected because size compensates.
- **Tighter apparent spacing.** Light halos around letterforms reduce perceived gaps. Increase `line-height` by 0.05-0.1 beyond your light-background value. For display sizes, add 0.01em `letter-spacing` to counteract.

## OpenType Features for Data

Most fonts ship with OpenType features that are off by default. Turn them on for data compositions:

```css
/* Tabular numbers — digits align vertically in columns */
.stat-value,
.timer,
.data-column {
  font-variant-numeric: tabular-nums;
}

/* Diagonal fractions — renders 1/2 as ½ */
.recipe-amount,
.ratio {
  font-variant-numeric: diagonal-fractions;
}

/* Small caps for abbreviations — less visual shouting */
.abbreviation,
.unit {
  font-variant-caps: all-small-caps;
}

/* Disable ligatures in code — fi, fl, ffi should stay separate */
code,
.code {
  font-variant-ligatures: none;
}
```

`tabular-nums` is essential any time numbers are stacked vertically — stat callouts, timers, scoreboards, data tables. Without it, digits have proportional widths and columns don't align.
