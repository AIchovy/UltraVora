# 阶段⑤ 营销主页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 未登录访问 `/` 看到英文营销主页(sticky header / hero / 六阶段 features / FAQ 手风琴 / footer,无定价);登录后照旧看到现有应用。

**Architecture:** 全部为 React Server Components(无 "use client"),放在 `apps/web/src/components/marketing/`;`app/page.tsx` 由"未登录 redirect /login"改为"未登录渲染 LandingPage"。FAQ 用原生 `<details>/<summary>`(零新依赖、可访问)。视觉延续现有设计语言(暖石 oklch + 炭色 primary + Geist + 阴影分层,light-only)。

**Tech Stack:** Next.js 15 App Router、Tailwind v4(@theme 令牌)、lucide-react、现有 ui/Button(asChild)、LogoMark。测试:vitest + @testing-library/react(根目录 unit 工程)。

---

## 设计决策(已定,不要在实现时改变)

| 决策点 | 结论 | 理由 |
|---|---|---|
| 组件形态 | 全部 Server Components,无 motion/react | 静态内容;入场动画留给 T3 用 CSS keyframes(globals.css `@theme` 加 `--animate-*`),自动受现有 reduced-motion 约束 |
| FAQ 手风琴 | 原生 `<details>/<summary>` + `group-open:` 样式 | 零依赖、键盘可访问;repo 没有 @radix-ui/react-accordion,不为此加依赖(YAGNI) |
| hero 产品视觉 | 纯 JSX/Tailwind 的应用窗口 mockup(ProductGlimpse,aria-hidden) | repo 无 public/ 目录、无真实截图;代码化 mockup 无二进制资产、跟随主题令牌 |
| seed gallery 素材 | 抽取 `src/lib/seed-styles.ts` 共享(home-page 与 landing 同源) | spec §6 要求 features 配合现有 seed gallery 素材;抽取避免 4 个 picsum URL 双份维护(DRY) |
| 图片 | 沿用 picsum.photos 占位(与现有 home-page 一致),原生 `<img>` + eslint-disable | 与应用现状一致;repo 未用 next/image;无新静态资产,故无需建 public/(spec"静态资源走 /public 不进桶"自然满足) |
| 路由文件测试 | `app/page.tsx` 的登录分支补一个 mock 化分支测试 | 这是本阶段验收标准本身("未登录看到主页,登录后看到现有应用"),值得 pin 住;其余路由文件维持"薄胶水不测"惯例 |
| footer 链接 | 只放真实存在的目标(#features / #faq / /login)+ 版权行 | 不发明 /terms /privacy 死链;spec 未要求法务页 |
| 文案语言 | 全英文,卖点忠于真实能力(四模式、15/30s、16:9 与 9:16、审批门、关页续跑) | spec:英文优先面向全球;不许诺不存在的功能(定价、模板市场等) |
| metadata | `app/page.tsx` 导出 title + description | 营销页需要 SEO 描述;登录态共用同一 metadata 无害 |

### ⚠️ 测试 gotcha(写测试前先读)

- **重复文本会让 `getByText` 抛错**:hero 的 ProductGlimpse mockup 里有 "Research / Design / Script / Voiceover / Compose & render" 字样,features 卡片里也有。features 断言必须用 `within(screen.getByRole("list", { name: "Pipeline stages" }))` 限定范围。
- **"Get started" 与 "Sign in" 各出现两次**(header+hero / header+footer):用 `getAllByRole` 并断言每个 href 都是 `/login`,不要用 `getByRole`。
- jsdom 不实现 `<summary>` 点击切换 `open`,FAQ 只断言结构(details/summary 存在、问题文本在),不测交互。
- 根 page 测试必须 mock `@/components/app-shell`、`@/components/home-page`、`@/components/marketing/landing-page` 与 `@/lib/server-session`,否则 AppShell 会拉 react-query/SSE 一整串依赖。
- 测试运行方式:`pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/landing-page.test.tsx`(根目录执行)。

---

## File Structure

```
apps/web/src/lib/seed-styles.ts                      (新建:共享 seed 数据)
apps/web/src/components/marketing/landing-page.tsx   (新建:组合)
apps/web/src/components/marketing/landing-header.tsx (新建:sticky header)
apps/web/src/components/marketing/landing-hero.tsx   (新建:hero + ProductGlimpse)
apps/web/src/components/marketing/landing-features.tsx (新建:六阶段 + 风格条)
apps/web/src/components/marketing/landing-faq.tsx    (新建:FAQ)
apps/web/src/components/marketing/landing-footer.tsx (新建:footer)
apps/web/src/components/home-page.tsx                (修改:SEEDS 改用共享模块)
apps/web/src/app/page.tsx                            (修改:未登录渲染 LandingPage)
apps/web/test/components/landing-page.test.tsx       (新建)
apps/web/test/app/page.test.tsx                      (新建)
```

---

### Task 1: seed-styles 抽取 + 营销主页组件 + 测试

**Files:**
- Create: `apps/web/src/lib/seed-styles.ts`
- Create: `apps/web/src/components/marketing/landing-page.tsx`
- Create: `apps/web/src/components/marketing/landing-header.tsx`
- Create: `apps/web/src/components/marketing/landing-hero.tsx`
- Create: `apps/web/src/components/marketing/landing-features.tsx`
- Create: `apps/web/src/components/marketing/landing-faq.tsx`
- Create: `apps/web/src/components/marketing/landing-footer.tsx`
- Modify: `apps/web/src/components/home-page.tsx`(删除本地 `Seed`/`SEEDS`,改 import)
- Test: `apps/web/test/components/landing-page.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/components/landing-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LandingPage } from "@/components/marketing/landing-page";

describe("LandingPage", () => {
  it("renders exactly one h1 with the hero pitch", () => {
    render(<LandingPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/promo videos/i);
  });

  it("every Get started CTA links to /login", () => {
    render(<LandingPage />);
    const ctas = screen.getAllByRole("link", { name: /get started/i });
    expect(ctas.length).toBeGreaterThanOrEqual(2); // header + hero
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/login");
  });

  it("every Sign in link points to /login", () => {
    render(<LandingPage />);
    const links = screen.getAllByRole("link", { name: /^sign in$/i });
    expect(links.length).toBeGreaterThanOrEqual(2); // header + footer
    for (const l of links) expect(l).toHaveAttribute("href", "/login");
  });

  it("header anchors navigate to #features and #faq, and both targets exist", () => {
    const { container } = render(<LandingPage />);
    const nav = screen.getByRole("navigation", { name: /landing sections/i });
    expect(within(nav).getByRole("link", { name: "Features" })).toHaveAttribute("href", "#features");
    expect(within(nav).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "#faq");
    expect(container.querySelector("#features")).not.toBeNull();
    expect(container.querySelector("#faq")).not.toBeNull();
  });

  it("features section lists all six pipeline stages", () => {
    render(<LandingPage />);
    const list = screen.getByRole("list", { name: "Pipeline stages" });
    for (const stage of ["Prompt", "Research", "Design", "Script", "Voiceover", "Compose & render"]) {
      expect(within(list).getByText(stage)).toBeInTheDocument();
    }
  });

  it("style gallery reuses the seed styles and links to /login", () => {
    render(<LandingPage />);
    const card = screen.getByRole("link", { name: /sleek tech/i });
    expect(card).toHaveAttribute("href", "/login");
  });

  it("FAQ renders as native details/summary with the lead question", () => {
    const { container } = render(<LandingPage />);
    const items = container.querySelectorAll("#faq details");
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("What is UltraCreator?")).toBeInTheDocument();
  });

  it("footer shows the copyright line", () => {
    render(<LandingPage />);
    expect(within(screen.getByRole("contentinfo")).getByText(/© 2026 UltraCreator/)).toBeInTheDocument();
  });

  it("contains no pricing content (out of scope this phase)", () => {
    render(<LandingPage />);
    expect(screen.queryByText(/pricing|\$\d/i)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/landing-page.test.tsx`
Expected: FAIL — cannot resolve `@/components/marketing/landing-page`。

- [ ] **Step 3: 抽取共享 seed 数据**

`apps/web/src/lib/seed-styles.ts`(内容从 home-page.tsx 的 SEEDS 原样搬来):

```ts
/**
 * The four "promo style" seeds shared by the logged-in home gallery and the
 * marketing landing page. Images are deterministic picsum placeholders keyed
 * by seed name (swap for real renders once we have them).
 */
export interface SeedStyle {
  title: string;
  inspiration: string;
  prompt: string;
  img: string;
}

export const SEED_STYLES: SeedStyle[] = [
  {
    title: "Sleek tech",
    inspiration: "Apple-style minimal reveal",
    prompt:
      "Slow rotating hero shot of the product on a seamless studio background, crisp key light, clean type animating the three headline features.",
    img: "https://picsum.photos/seed/uc-sleek-tech/640/420",
  },
  {
    title: "Cozy lifestyle",
    inspiration: "Warm DTC, hands-on",
    prompt:
      "The product in a sunlit kitchen, hands using it naturally in warm morning light, soft handheld motion, inviting and homey.",
    img: "https://picsum.photos/seed/uc-cozy-lifestyle/640/420",
  },
  {
    title: "Bold & punchy",
    inspiration: "High-energy social ad",
    prompt:
      "Fast cuts on a vibrant color backdrop, the product snapping into frame, oversized kinetic type, upbeat and scroll-stopping.",
    img: "https://picsum.photos/seed/uc-bold-punchy/640/420",
  },
  {
    title: "Premium unbox",
    inspiration: "Luxe macro, tactile",
    prompt:
      "Macro unboxing on a dark backdrop, dramatic rim light catching the edges, slow reveal of materials and finish, premium and tactile.",
    img: "https://picsum.photos/seed/uc-premium-unbox/640/420",
  },
];
```

修改 `apps/web/src/components/home-page.tsx`:删除本地 `interface Seed` 与 `const SEEDS`,顶部加 `import { SEED_STYLES } from "@/lib/seed-styles";`,`SEEDS.map` 改为 `SEED_STYLES.map`(其余渲染代码不动)。

- [ ] **Step 4: header / footer 组件**

`apps/web/src/components/marketing/landing-header.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/logo";

const NAV = [
  { label: "Features", href: "#features" },
  { label: "FAQ", href: "#faq" },
] as const;

export function LandingHeader(): React.ReactElement {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraCreator</span>
        </Link>
        <nav aria-label="Landing sections" className="hidden items-center gap-6 sm:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
```

`apps/web/src/components/marketing/landing-footer.tsx`:

```tsx
import Link from "next/link";
import { LogoMark } from "@/components/logo";

export function LandingFooter(): React.ReactElement {
  return (
    <footer className="border-t border-border/60 bg-muted/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <LogoMark className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">UltraCreator</div>
            <div className="text-xs text-muted-foreground">Your everyday video studio.</div>
          </div>
        </div>
        <nav aria-label="Footer" className="flex items-center gap-6 text-sm text-muted-foreground">
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <a href="#faq" className="transition-colors hover:text-foreground">
            FAQ
          </a>
          <Link href="/login" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground/70">© 2026 UltraCreator. All rights reserved.</p>
      </div>
    </footer>
  );
}
```

- [ ] **Step 5: hero + ProductGlimpse**

`apps/web/src/components/marketing/landing-hero.tsx`:

```tsx
import Link from "next/link";
import { ArrowRight, Check, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

const GLIMPSE_STAGES = ["Research", "Design", "Script", "Voiceover"] as const;

/**
 * Decorative, theme-token-driven mockup of a running session (chat rail +
 * render preview). Pure JSX — no screenshots, no binary assets.
 */
function ProductGlimpse(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <div className="absolute -inset-6 rounded-[2rem] bg-accent/60 blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-panel">
        <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/60 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="ml-3 truncate text-[11px] font-medium text-muted-foreground">
            UltraCreator — Sunlit kitchen promo
          </span>
        </div>
        <div className="grid grid-cols-[1fr_1.5fr]">
          <div className="space-y-2.5 border-r border-border/70 p-4">
            <div className="w-fit max-w-full rounded-xl rounded-tl-sm bg-primary px-3 py-2 text-[11px] leading-snug text-primary-foreground">
              A 15s spot for our ceramic mug — warm morning light, three quick benefits.
            </div>
            <div className="space-y-1.5 pt-1">
              {GLIMPSE_STAGES.map((stage) => (
                <div key={stage} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Check className="h-3 w-3 text-foreground/70" />
                  {stage}
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                Compose &amp; render
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-2/3 rounded-full bg-primary/70" />
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-foreground">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/20 backdrop-blur-sm">
                <Play className="ml-0.5 h-4 w-4 fill-background text-background" />
              </span>
              <span className="absolute inset-x-3 bottom-2 truncate text-center text-[10px] text-background/80">
                Morning light. Real moments. One mug.
              </span>
            </div>
            <div className="mt-3 flex items-center gap-1">
              <span className="h-1.5 flex-[2] rounded-full bg-primary/80" />
              <span className="h-1.5 flex-[3] rounded-full bg-border" />
              <span className="h-1.5 flex-[1.5] rounded-full bg-border" />
              <span className="h-1.5 flex-[2.5] rounded-full bg-border" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingHero(): React.ReactElement {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 pb-20 pt-16 md:pt-24 lg:grid-cols-[1fr_1.05fr] lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Your everyday video studio
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl lg:text-[3.4rem] lg:leading-[1.05]">
            Promo videos from a single prompt.
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            UltraCreator researches your product, drafts the brief and the script, records the
            voiceover, and renders the final cut. You direct — it does the production.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href="/login">
                Get started
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a href="#features">See how it works</a>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Sign in with Google — your first video is one prompt away.
          </p>
        </div>
        <ProductGlimpse />
      </div>
    </section>
  );
}
```

- [ ] **Step 6: features 六阶段 + 风格条**

`apps/web/src/components/marketing/landing-features.tsx`:

```tsx
import Link from "next/link";
import {
  Clapperboard,
  MessageSquareText,
  Mic,
  Palette,
  ScrollText,
  Telescope,
} from "lucide-react";
import { SEED_STYLES } from "@/lib/seed-styles";

interface PipelineStage {
  step: string;
  name: string;
  icon: typeof Palette;
  title: string;
  body: string;
}

const STAGES: PipelineStage[] = [
  {
    step: "01",
    name: "Prompt",
    icon: MessageSquareText,
    title: "Start from a sentence",
    body: "Describe the video you want — a product, a vibe, a length. Pick cinematic, social, commercial, or freeform.",
  },
  {
    step: "02",
    name: "Research",
    icon: Telescope,
    title: "It studies your product first",
    body: "Before writing a single line, UltraCreator digs into your product and audience so the video sells the right thing.",
  },
  {
    step: "03",
    name: "Design",
    icon: Palette,
    title: "A creative brief you approve",
    body: "Mood, palette, pacing — a visual direction lands for review. Approve it or ask for another take before production.",
  },
  {
    step: "04",
    name: "Script",
    icon: ScrollText,
    title: "Scene-by-scene script",
    body: "Every shot, caption, and beat laid out on a timeline you can read — and revise — at a glance.",
  },
  {
    step: "05",
    name: "Voiceover",
    icon: Mic,
    title: "Narration built in",
    body: "A studio-quality voiceover is generated and timed to the script, ready to swap until it sounds right.",
  },
  {
    step: "06",
    name: "Compose & render",
    icon: Clapperboard,
    title: "The final cut, rendered",
    body: "Footage, voice, music, and captions are composed and rendered into a share-ready video — widescreen or vertical.",
  },
];

export function LandingFeatures(): React.ReactElement {
  return (
    <section id="features" className="scroll-mt-20 border-t border-border/60 bg-muted/40">
      <div className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            A six-stage studio, run for you.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Every video moves through the same pipeline a production team would use. You approve
            the work at the gates; UltraCreator does the rest.
          </p>
        </div>
        <ol aria-label="Pipeline stages" className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STAGES.map((stage) => {
            const Icon = stage.icon;
            return (
              <li key={stage.step} className="rounded-2xl border border-border/70 bg-card p-6 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground/70">{stage.step}</span>
                </div>
                <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {stage.name}
                </div>
                <h3 className="mt-1 text-base font-semibold tracking-tight">{stage.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{stage.body}</p>
              </li>
            );
          })}
        </ol>
        <div className="mt-16">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Start from a style
            </h3>
            <span className="text-xs text-muted-foreground/70">Four directions, one prompt each</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SEED_STYLES.map((seed) => (
              <Link
                key={seed.title}
                href="/login"
                className="group relative aspect-[3/4] overflow-hidden rounded-2xl bg-muted shadow-card transition-shadow hover:shadow-raised"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={seed.img}
                  alt={seed.title}
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-3 text-white">
                  <div className="text-sm font-semibold">{seed.title}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-white/70">{seed.inspiration}</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 7: FAQ**

`apps/web/src/components/marketing/landing-faq.tsx`:

```tsx
import { ChevronDown } from "lucide-react";

const FAQS: { q: string; a: string }[] = [
  {
    q: "What is UltraCreator?",
    a: "An AI video studio that turns a written prompt into a finished promo video. It researches your product, plans the creative, writes the script, records the voiceover, and renders the final cut — you review and approve along the way.",
  },
  {
    q: "Do I need video editing experience?",
    a: "No. You describe what you want in plain language and give feedback the same way. UltraCreator handles the editing, mixing, captions, and rendering.",
  },
  {
    q: "Can I change something I don't like?",
    a: "Yes. The pipeline pauses for your approval at key stages — the creative brief and the script — and after the render you can ask for tweaks and re-render what changed.",
  },
  {
    q: "What formats do I get?",
    a: "Share-ready video in widescreen 16:9 or vertical 9:16, as 15- or 30-second cuts, with captions included.",
  },
  {
    q: "What happens if I close the tab mid-render?",
    a: "Nothing is lost. Generation runs on our servers, not in your browser — close the laptop, come back later, and your session picks up exactly where it left off.",
  },
  {
    q: "How do I sign in?",
    a: "With your Google account — one click, no setup. Email sign-in is coming soon.",
  },
];

export function LandingFaq(): React.ReactElement {
  return (
    <section id="faq" className="scroll-mt-20 border-t border-border/60">
      <div className="mx-auto w-full max-w-3xl px-6 py-20">
        <h2 className="text-center text-3xl font-semibold tracking-tight md:text-4xl">
          Frequently asked questions
        </h2>
        <div className="mt-10 divide-y divide-border/70 rounded-2xl border border-border/70 bg-card shadow-card">
          {FAQS.map((faq) => (
            <details key={faq.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                {faq.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 8: 组合组件**

`apps/web/src/components/marketing/landing-page.tsx`:

```tsx
import { LandingFaq } from "./landing-faq";
import { LandingFeatures } from "./landing-features";
import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";
import { LandingHero } from "./landing-hero";

/** Marketing homepage shown to logged-out visitors at `/` (spec §6). */
export function LandingPage(): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingHeader />
      <main>
        <LandingHero />
        <LandingFeatures />
        <LandingFaq />
      </main>
      <LandingFooter />
    </div>
  );
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/landing-page.test.tsx`
Expected: PASS(9 个用例)。再跑受影响的既有测试:
`pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/home-composer.test.tsx`
Expected: PASS(home-page 改动只换数据来源)。

- [ ] **Step 10: typecheck + commit**

Run: `pnpm typecheck`
Expected: 0 errors。

```bash
git add apps/web/src/lib/seed-styles.ts apps/web/src/components/marketing apps/web/src/components/home-page.tsx apps/web/test/components/landing-page.test.tsx
git commit -m "feat(web): marketing landing page components (phase 5 T1)"
```

---

### Task 2: 根路由接入 + metadata + 分支测试

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Test: `apps/web/test/app/page.test.tsx`(新建,新目录)

- [ ] **Step 1: 写失败测试**

`apps/web/test/app/page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Page from "@/app/page";
import { getServerSession } from "@/lib/server-session";

vi.mock("@/lib/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));
vi.mock("@/components/home-page", () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock("@/components/marketing/landing-page", () => ({
  LandingPage: () => <div data-testid="landing-page" />,
}));

const getSessionMock = vi.mocked(getServerSession);

describe("root page", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it("renders the marketing landing page when logged out", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await Page());
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("renders the app shell with the home page when logged in", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "u1", email: "u@example.com", name: "U" } });
    render(await Page());
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.queryByTestId("landing-page")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/app/page.test.tsx`
Expected: FAIL — 未登录分支当前是 `redirect("/login")`(mock 后会抛 next/navigation 的 redirect 错误或渲染不到 landing-page)。

- [ ] **Step 3: 改根路由**

`apps/web/src/app/page.tsx` 整文件改为:

```tsx
import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/components/home-page";
import { LandingPage } from "@/components/marketing/landing-page";
import { getServerSession } from "@/lib/server-session";

export const metadata: Metadata = {
  title: "UltraCreator — Your everyday video studio",
  description:
    "Turn a single prompt into a finished promo video. UltraCreator researches your product, writes the script, records the voiceover, and renders the final cut.",
};

export default async function Page(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) return <LandingPage />;
  return (
    <AppShell>
      <HomePage />
    </AppShell>
  );
}
```

(删除 `redirect` import 与"阶段⑤会把这里改成营销主页"的注释——本阶段就是它。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/app/page.test.tsx`
Expected: PASS(2 个用例)。

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
Expected: 0 errors。

```bash
git add apps/web/src/app/page.tsx apps/web/test/app/page.test.tsx
git commit -m "feat(web): logged-out / renders marketing landing page (phase 5 T2)"
```

---

### Task 3: 视觉打磨(design-taste-frontend)+ preview 验证

**Files:**
- Modify: `apps/web/src/components/marketing/*.tsx`(允许范围)
- Modify: `apps/web/src/app/globals.css`(仅允许追加 `--animate-*` 等令牌/keyframes,不许动既有令牌)

> 本任务交给最强模型;不改行为、不加依赖、不动 marketing 目录外的组件(globals.css 追加除外)。所有 T1 测试必须保持绿色。

- [ ] **Step 1: 调用 design-taste-frontend 技能**(Skill 工具,名称 `design-taste-frontend`)

设计读法(已定,直接采用):"Reading this as: prosumer SaaS landing for global creators & small businesses, premium-minimal warm-stone language extending the existing app design system (oklch warm stone + charcoal primary + Geist + layered shadows, light-only), Tailwind v4 utilities + restrained CSS motion." 拨盘:VARIANCE 7 / MOTION 4 / DENSITY 3。反默认纪律:禁止 AI 紫渐变、暗色 mesh hero、三等宽卡片陈词滥调;延续既有 token,不引入新字体/新色相。

- [ ] **Step 2: 预览验证(preview_* 工具)**

1. `preview_list` 看是否已有 dev server(早前可能有 name "web" 的 server);没有则 `preview_start`(apps/web,`pnpm dev`,port 3000)。
2. 访问 `/`。若看到的是登录后应用(浏览器有 cookie),先 `preview_eval` 执行 `await fetch("/api/auth/sign-out", { method: "POST" })` 再 reload,即可看到营销主页。
3. `preview_console_logs` 确认无错误;`preview_snapshot` 检查结构。
4. `preview_screenshot` 桌面宽度;`preview_resize` 到 390×844 再截图(移动端:anchor nav 隐藏、CTA 仍在、布局不破)。

- [ ] **Step 3: 依截图迭代打磨**

关注:标题字阶与行高节奏、区块间距韵律(py 一致性)、ProductGlimpse 细节真实感、hover 状态、FAQ 展开态样式、入场动画(若加:CSS `@theme` `--animate-fade-up` keyframes,默认尊重 prefers-reduced-motion)。每轮改完重截图对比。

**T1 质量审查遗留的 Minor 修复(必做,均为一行级):**
1. `landing-features.tsx` 画廊卡片 `alt={seed.title}` 与可见标题重复造成读屏名称冗余 → 改 `alt=""`(`home-page.tsx:139` 同款问题一并改,保持一致)。
2. `landing-features.tsx` 四张画廊图加 `loading="lazy" decoding="async"`(下折外的第三方图不抢首屏)。
3. `landing-page.test.tsx` 版权断言改为年份不敏感:`/© \d{4} UltraCreator/`(footer 文案保持静态 © 2026)。
4. 加一行测试:断言包含 mockup 文案的 ProductGlimpse 容器有 `aria-hidden="true"`(这是 within() 测试策略的承重前提,防 T3 重构时丢失)。
5. `#features` 与 `#faq` 两个 section 加 `tabIndex={-1}`,让锚点跳转后键盘/读屏焦点落到目标区块。
6. 移动端(390px)确认无 anchor nav 的取舍可接受(hero 的 "See how it works" 仍可达 #features)。

**上线前跟踪项(不在本阶段)**:picsum 占位图需换成真实渲染成品图(seed-styles.ts 已注明 swap 意图)——营销页是产品第一印象,占位风景照不可上线。

- [ ] **Step 4: 测试回归 + commit**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/landing-page.test.tsx apps/web/test/app/page.test.tsx`
Expected: PASS。

```bash
git add apps/web/src/components/marketing apps/web/src/app/globals.css
git commit -m "polish(web): landing page visual refinement (phase 5 T3)"
```

---

### Task 4: 全量回归 + 终审

- [ ] **Step 1: 全量测试**

Run: `pnpm test`(根目录)
Expected: 全绿(允许既有 1 skipped)。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 3: opus 终审整个阶段⑤**(controller dispatch,review 范围:本阶段全部 commit)

- [ ] **Step 4: 通过后 ff-merge 到本地 main**(controller 执行;push 仅在用户要求时)

---

## 手工验收清单(用户)

- [ ] 未登录访问 `http://localhost:3000/` → 看到英文营销主页(header/hero/features/FAQ/footer,无定价)
- [ ] 点 header "Features"/"FAQ" 锚点平滑滚动到对应区块
- [ ] 点 "Get started" / "Sign in" → 进入 /login,Google 登录成功后回到 `/` 看到现有应用
- [ ] 登录态直接访问 `/` → 现有应用,无营销内容闪现
- [ ] 手机宽度(≤390px)布局不破
