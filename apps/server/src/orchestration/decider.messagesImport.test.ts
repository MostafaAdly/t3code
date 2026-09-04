import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Imported",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread.messages.import decider", (it) => {
  it.effect("records one message-sent event per message with the original timestamps", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.messages.import",
          commandId: CommandId.make("cmd-import"),
          threadId: ThreadId.make("thread-1"),
          messages: [
            {
              messageId: MessageId.make("m-1"),
              role: "user",
              text: "Fix the bug",
              createdAt: "2025-12-01T10:00:00.000Z",
            },
            {
              messageId: MessageId.make("m-2"),
              role: "assistant",
              text: "Done.",
              createdAt: "2025-12-01T10:00:09.000Z",
            },
          ],
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
      ]);
      const [first, second] = events;
      if (first?.type === "thread.message-sent" && second?.type === "thread.message-sent") {
        expect(first.payload.role).toBe("user");
        expect(first.payload.text).toBe("Fix the bug");
        // No turn and no streaming: imported history is inert.
        expect(first.payload.turnId).toBeNull();
        expect(first.payload.streaming).toBe(false);
        expect(first.occurredAt).toBe("2025-12-01T10:00:00.000Z");
        expect(second.payload.role).toBe("assistant");
        expect(second.occurredAt).toBe("2025-12-01T10:00:09.000Z");
      }
    }),
  );

  it.effect("refuses to import into a thread that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.messages.import",
          commandId: CommandId.make("cmd-import-missing"),
          threadId: ThreadId.make("thread-missing"),
          messages: [],
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
