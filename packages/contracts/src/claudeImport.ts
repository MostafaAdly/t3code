import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Importing Claude Code transcripts (`~/.claude/projects/**.jsonl`) as Adly
 * threads. The transcripts are only ever read; the import goes through the
 * normal orchestration commands so it lands in the UI live.
 */

// How far back to look, judged by each session's last message.
export const ClaudeImportRange = Schema.Literals(["1w", "2w", "1m", "3m", "all"]);
export type ClaudeImportRange = typeof ClaudeImportRange.Type;

export const ClaudeImportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  range: ClaudeImportRange,
});
export type ClaudeImportInput = typeof ClaudeImportInput.Type;

export const ClaudeImportProjectSummary = Schema.Struct({
  workspaceRoot: Schema.String,
  title: Schema.String,
  sessions: Schema.Number,
  messages: Schema.Number,
  isNew: Schema.Boolean,
});
export type ClaudeImportProjectSummary = typeof ClaudeImportProjectSummary.Type;

/** What a run would do, before anything is written. */
export const ClaudeImportPlan = Schema.Struct({
  sessions: Schema.Number,
  messages: Schema.Number,
  projects: Schema.Array(ClaudeImportProjectSummary),
  newProjects: Schema.Number,
  alreadyImported: Schema.Number,
  skippedNoFolder: Schema.Number,
});
export type ClaudeImportPlan = typeof ClaudeImportPlan.Type;

export const ClaudeImportProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    sessionsDone: Schema.Number,
    sessionsTotal: Schema.Number,
    messagesDone: Schema.Number,
    messagesTotal: Schema.Number,
    currentProject: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    sessions: Schema.Number,
    messages: Schema.Number,
    newProjects: Schema.Number,
  }),
]);
export type ClaudeImportProgressEvent = typeof ClaudeImportProgressEvent.Type;

export class ClaudeImportError extends Schema.TaggedErrorClass<ClaudeImportError>()(
  "ClaudeImportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
