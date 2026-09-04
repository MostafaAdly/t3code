import { describe, expect, it } from "vite-plus/test";

import {
  lastMessageTimeMs,
  mergeClaudeSessions,
  parseClaudeTranscript,
} from "./claudeTranscript.ts";

const line = (record: Record<string, unknown>) => JSON.stringify(record);
const user = (text: string, at: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "user",
    uuid: `u-${at}`,
    timestamp: at,
    cwd: "/repo",
    sessionId: "sess-1",
    message: { role: "user", content: text },
    ...extra,
  });
const assistant = (blocks: Array<Record<string, unknown>>, at: string) =>
  line({
    type: "assistant",
    uuid: `a-${at}`,
    timestamp: at,
    sessionId: "sess-1",
    message: { role: "assistant", content: blocks },
  });

describe("parseClaudeTranscript", () => {
  it("keeps prompts and replies, drops tool plumbing, thinking, and sidechains", () => {
    const text = [
      line({ type: "queue-operation", sessionId: "sess-1" }),
      user("Fix the bug", "2026-09-01T10:00:00.000Z"),
      assistant(
        [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Looking." },
          { type: "tool_use", name: "Read", input: {} },
        ],
        "2026-09-01T10:00:05.000Z",
      ),
      line({
        type: "user",
        uuid: "tool-result",
        timestamp: "2026-09-01T10:00:06.000Z",
        message: { role: "user", content: [{ type: "tool_result", content: "file contents" }] },
      }),
      assistant([{ type: "text", text: "Fixed it." }], "2026-09-01T10:00:09.000Z"),
      user("thanks", "2026-09-01T10:01:00.000Z", { isSidechain: true }),
      user("<command-name>/clear</command-name>", "2026-09-01T10:02:00.000Z"),
      line({ type: "custom-title", title: "Bug fix session" }),
      "{not json",
    ].join("\n");

    const session = parseClaudeTranscript(text, "file-name");
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("sess-1");
    expect(session!.cwd).toBe("/repo");
    expect(session!.title).toBe("Bug fix session");
    expect(session!.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Fix the bug"],
      // Two assistant records around a tool result collapse into one reply.
      ["assistant", "Looking.\n\nFixed it."],
    ]);
    expect(session!.createdAt).toBe("2026-09-01T10:00:00.000Z");
    expect(session!.updatedAt).toBe("2026-09-01T10:00:09.000Z");
  });

  it("returns null when nothing conversational is present", () => {
    expect(parseClaudeTranscript(line({ type: "attachment" }), "x")).toBeNull();
    expect(parseClaudeTranscript("", "x")).toBeNull();
  });

  it("falls back to the file name and first prompt when ids and titles are missing", () => {
    const text = line({
      type: "user",
      timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "user", content: "Hello there\nsecond line" },
    });
    const session = parseClaudeTranscript(text, "abc-123");
    expect(session!.sessionId).toBe("abc-123");
    expect(session!.title).toBe("Hello there");
  });
});

describe("mergeClaudeSessions", () => {
  it("unions continuation files by record uuid and keeps time order", () => {
    const first = parseClaudeTranscript(
      [
        user("one", "2026-09-01T10:00:00.000Z"),
        assistant([{ type: "text", text: "A" }], "2026-09-01T10:00:01.000Z"),
      ].join("\n"),
      "f1",
    )!;
    const second = parseClaudeTranscript(
      [
        user("one", "2026-09-01T10:00:00.000Z"),
        assistant([{ type: "text", text: "A" }], "2026-09-01T10:00:01.000Z"),
        user("two", "2026-09-01T10:05:00.000Z"),
        assistant([{ type: "text", text: "B" }], "2026-09-01T10:05:01.000Z"),
      ].join("\n"),
      "f2",
    )!;
    const merged = mergeClaudeSessions([second, first]);
    expect(merged.messages.map((m) => m.text)).toEqual(["one", "A", "two", "B"]);
    expect(merged.updatedAt).toBe("2026-09-01T10:05:01.000Z");
  });
});

describe("lastMessageTimeMs", () => {
  it("reads the newest user or assistant timestamp from a tail, ignoring other records", () => {
    const tail = [
      user("x", "2026-09-01T10:00:00.000Z"),
      line({ type: "custom-title", timestamp: "2026-09-03T00:00:00.000Z", title: "t" }),
      "{partial",
    ].join("\n");
    expect(lastMessageTimeMs(tail)).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    expect(lastMessageTimeMs(line({ type: "attachment" }))).toBeNull();
  });
});
