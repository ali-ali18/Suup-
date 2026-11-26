import { describe, expect, it } from "vitest";
import { webReadTool } from "../src/web-read.js";

describe("web_read: a page never gets a session grant", () => {
  it("has no grantKey, so approving one address never covers another on the same host", () => {
    expect(webReadTool.grantKey).toBeUndefined();
  });
});
