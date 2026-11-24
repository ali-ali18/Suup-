import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, type AvatarSize, cornerMask, cornerStatus } from "./avatar.js";

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

  it("is in every size that has room for it: 12 px under 44 px, 16 px from 44 px (fixed, never proportional)", () => {
    for (const size of ["sm", "md", "row"] as const) {
      const star = draw({ supervisor: true, size }).querySelector(
        '[data-testid="supervisor-star"]',
      );
      expect(star?.className, size).toContain("size-star-badge");
      expect(star?.className, size).not.toContain("size-star-badge-lg");
      cleanup();
    }
    for (const size of ["lg", "xl", "preview", "tile"] as const) {
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
      expect(star?.getAttribute("aria-label")).toBe("Bot principal");
      expect(star?.parentElement?.className).toContain("relative");
      expect(star?.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });

  it("is the owner's orange marker with a white star, at fixed sizes, and the face is notched around it", () => {
    const small = draw({ supervisor: true, size: "row" });
    const star = small.querySelector<HTMLElement>('[data-testid="supervisor-star"]');
    expect(star?.className).toContain("bg-star-badge");
    expect(star?.className).toContain("text-star-glyph");
    expect(star?.querySelector("svg")?.getAttribute("class")).toContain("size-star-glyph");
    expect(star?.getAttribute("aria-label")).toBe("Bot principal");
    expect(small.querySelector<HTMLElement>('[data-testid="avatar-notch"]')?.style.maskImage).toBe(
      cornerMask("--size-star-badge", "--size-star-gap"),
    );
    cleanup();
    const large = draw({ supervisor: true, size: "lg" });
    expect(large.querySelector<HTMLElement>('[data-testid="avatar-notch"]')?.style.maskImage).toBe(
      cornerMask("--size-star-badge-lg", "--size-star-gap-lg"),
    );
    cleanup();
    // no mark, no notch: the face is whole
    expect(draw({}).querySelector('[data-testid="avatar-notch"]')).toBeNull();
  });

  it("is the same for the shapes, the pixel mascots and the 3D ones", () => {
    for (const props of [
      { avatar: "mascot:blob" },
      { avatar: "pixel:folha", avatarStyle: "pixel" as const },
      { avatar: "pixel:folha", avatarStyle: "pixel" as const, pixel3d: true },
    ]) {
      const { container } = render(<Avatar seed="bot-1" still supervisor size="row" {...props} />);
      expect(
        container.querySelector('[data-testid="supervisor-star"]'),
        props.avatar,
      ).not.toBeNull();
      expect(container.querySelector('[data-testid="avatar-notch"]')).not.toBeNull();
      cleanup();
    }
  });
});

describe("the corner of the avatar: one status, by precedence (the owner's design)", () => {
  const corner = (props: { working?: boolean; unread?: boolean; supervisor?: boolean }) =>
    render(<Avatar avatar="mascot:blob" seed="bot-1" still size="row" {...props} />).container;

  it("working > unread > the star", () => {
    expect(cornerStatus({ working: true, unread: true, primary: true })).toBe("working");
    expect(cornerStatus({ unread: true, primary: true })).toBe("unread");
    expect(cornerStatus({ primary: true })).toBe("primary");
    expect(cornerStatus({})).toBe("none");
  });

  it("working is a green dot and unread a blue one, the face kept and notched; the star waits", () => {
    const busy = corner({ working: true, unread: true, supervisor: true });
    const dot = busy.querySelector<HTMLElement>('[data-testid="avatar-dot"]');
    expect(dot?.dataset.status).toBe("working");
    expect(dot?.className).toContain("bg-status-working");
    expect(dot?.className).toContain("size-status-dot-row");
    expect(dot?.getAttribute("aria-label")).toBe("Trabalhando");
    expect(busy.querySelector('[data-testid="supervisor-star"]')).toBeNull();
    expect(busy.querySelector("svg")).not.toBeNull(); // the face is still there
    expect(busy.querySelector<HTMLElement>('[data-testid="avatar-notch"]')?.style.maskImage).toBe(
      cornerMask("--size-status-dot-row", "--size-status-gap"),
    );
    cleanup();
    const unread = corner({ unread: true, supervisor: true });
    const blue = unread.querySelector<HTMLElement>('[data-testid="avatar-dot"]');
    expect(blue?.dataset.status).toBe("unread");
    expect(blue?.className).toContain("bg-status-unread");
    cleanup();
    expect(
      render(
        <Avatar avatar="mascot:blob" seed="b" still size="xs" working />,
      ).container.querySelector('[data-testid="avatar-dot"]'),
    ).toBeNull();
  });
});
