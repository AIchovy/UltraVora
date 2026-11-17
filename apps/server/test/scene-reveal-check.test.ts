import { describe, it, expect } from "vitest";
import { findHiddenContainerOpacityFroms } from "../src/render/scene-reveal-check.js";

const scenes = `
  <div id="scene_1" class="scene clip"><img class="logo"></div>
  <div id="scene_2" class="scene clip"></div>
  <div id="scene_4" class="scene clip"><div class="s4-content"></div></div>
`;

function doc(script: string): string {
  return `<body>${scenes}<script>\ngsap.set(".scene", { autoAlpha: 0 });\n${script}\n</script></body>`;
}

describe("findHiddenContainerOpacityFroms", () => {
  it("flags a bare opacity from() on a scene container (the blank-scene trap)", () => {
    const v = findHiddenContainerOpacityFroms(
      doc(`tl.from("#scene_4", { opacity: 0, scale: 0.95, duration: 1.5 }, 26.93);`),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/#scene_4/);
  });

  it("flags autoAlpha from() on a scene container too", () => {
    const v = findHiddenContainerOpacityFroms(doc(`gsap.from("#scene_4", { autoAlpha: 0, duration: 1 });`));
    expect(v).toHaveLength(1);
  });

  it("does NOT flag a transform-only entrance (x/y/scale)", () => {
    expect(findHiddenContainerOpacityFroms(doc(`tl.from("#scene_2", { y: "100%", duration: 1.2 });`))).toEqual([]);
  });

  it("does NOT flag an opacity from() on a CHILD of a scene container", () => {
    expect(
      findHiddenContainerOpacityFroms(doc(`tl.from("#scene_1 .logo", { opacity: 0, duration: 1 });`)),
    ).toEqual([]);
  });

  it("does NOT flag fromTo() with an explicit end (the recommended fix)", () => {
    expect(
      findHiddenContainerOpacityFroms(
        doc(`tl.fromTo("#scene_4", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 });`),
      ),
    ).toEqual([]);
  });

  it("does NOT flag the gsap.set() hide-all", () => {
    // The doc() wrapper already contains gsap.set(".scene", {autoAlpha:0}); nothing else.
    expect(findHiddenContainerOpacityFroms(doc(``))).toEqual([]);
  });

  it("returns [] for a composition with no script", () => {
    expect(findHiddenContainerOpacityFroms("<body><div class='scene'></div></body>")).toEqual([]);
  });
});
