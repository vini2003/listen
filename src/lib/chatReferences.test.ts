import { describe, expect, it } from "vitest";
import { parseRecordingHref, renderableChatContent } from "./chatReferences";

describe("chat recording references", () => {
  it("turns source markers into internal Markdown links", () => {
    const rendered = renderableChatContent(
      "That was approved [[recording:meeting-2|754000|Planning 12:34]].",
      "meeting-1",
    );

    expect(rendered).toContain("[Planning 12:34](#listen-recording=meeting-2&time=754000)");
  });

  it("upgrades legacy timestamp citations for the current recording", () => {
    expect(renderableChatContent("See [Planning 1:02].", "meeting-1"))
      .toContain("#listen-recording=meeting-1&time=62000");
  });

  it("parses internal recording destinations", () => {
    expect(parseRecordingHref("#listen-recording=meeting-2&time=754000"))
      .toEqual({ meetingId: "meeting-2", timeMs: 754000 });
    expect(parseRecordingHref("https://example.com")).toBeNull();
  });
});
