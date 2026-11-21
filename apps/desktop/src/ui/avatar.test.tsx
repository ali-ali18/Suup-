import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, type AvatarSize } from "./avatar.js";

afterEach(cleanup);

describe("the star of the main bot", () => {
  const draw = (props: { supervisor?: boolean; size?: AvatarSize; avatar?: string | null }) =>
    render(<Avatar avatar={props.avatar ?? "mascot:blob"} seed="bot-1" still {...props} />)
      .container;

  it("is a small chip on the avatar, for the main bot only", () => {
    expect(
      draw({ supervisor: true }).querySelector('[data-testid="supervisor-star"]'),
    ).not.toBeNull();
    cleanup();
    expect(draw({}).querySelector('[data-testid="supervisor-star"]')).toBeNull();
    cleanup();
    expect(draw({ supervisor: false }).querySelector('[data-testid="supervisor-star"]')).toBeNull();
  });

  it("is in every size that has room for it, small ones with the small chip and the large ones with the larger", () => {
    for (const size of ["sm", "md", "row", "lg", "tile"] as const) {
      const star = draw({ supervisor: true, size }).querySelector(
        '[data-testid="supervisor-star"]',
      );
      expect(star?.className, size).toContain("size-star-badge");
      expect(star?.className, size).not.toContain("size-star-badge-lg");
      cleanup();
    }
    for (const size of ["xl", "preview"] as const) {
      const star = draw({ supervisor: true, size }).querySelector(
        '[data-testid="supervisor-star"]',
      );
      expect(star?.className, size).toContain("size-star-badge-lg");
      cleanup();
    }
    // 16 px has no room: no star
    expect(
      draw({ supervisor: true, size: "xs" }).querySelector('[data-testid="supervisor-star"]'),
    ).toBeNull();
  });

  it("goes around the face, so it is the same for a mascot and for an emoji, and is hidden from screen readers", () => {
    for (const avatar of ["mascot:blob", "mascot:star", "🦊"]) {
      const container = draw({ supervisor: true, avatar });
      const star = container.querySelector('[data-testid="supervisor-star"]');
      expect(star?.getAttribute("aria-hidden")).toBe("true");
      expect(star?.parentElement?.className).toContain("relative");
      expect(star?.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });
});
