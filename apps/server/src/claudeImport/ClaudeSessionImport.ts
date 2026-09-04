/**
 * Imports Claude Code sessions as Adly threads through the orchestration
 * engine, so projections and every connected client update live.
 *
 * Transcripts are only ever read. A ledger in the state dir remembers which
 * Claude session ids became which threads, so repeat runs never import the
 * same session twice.
 *
 * @module claudeImport/ClaudeSessionImport
 */
import {
  ClaudeImportError,
  type ClaudeImportInput,
  type ClaudeImportPlan,
  type ClaudeImportProgressEvent,
  type ClaudeImportProjectSummary,
  type ClaudeImportRange,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  lastMessageTimeMs,
  mergeClaudeSessions,
  parseClaudeTranscript,
  type ClaudeTranscriptSession,
} from "./claudeTranscript.ts";

const RANGE_MS: Record<ClaudeImportRange, number | null> = {
  "1w": 7 * 86_400e3,
  "2w": 14 * 86_400e3,
  "1m": 30 * 86_400e3,
  "3m": 90 * 86_400e3,
  all: null,
};

// Messages per orchestration command; keeps each event batch small enough
// that a long session still streams progress instead of landing all at once.
const MESSAGES_PER_COMMAND = 100;

// Only the tail of a transcript is read to date it; the last message is
// almost always within this window.
const TAIL_BYTES = 512 * 1024;

// Claude session id -> the Adly thread it became.
const ImportLedger = Schema.Record(
  Schema.String,
  Schema.Struct({ threadId: Schema.String, importedAt: Schema.String }),
);
type ImportLedger = typeof ImportLedger.Type;
const decodeLedger = Schema.decodeUnknownSync(Schema.fromJsonString(ImportLedger));
const encodeLedger = Schema.encodeSync(Schema.fromJsonString(ImportLedger));

const isClaudeImportError = Schema.is(ClaudeImportError);

interface PlannedSession {
  readonly session: ClaudeTranscriptSession;
  readonly workspaceRoot: string;
}

export const makeClaudeSessionImport = Effect.fn("makeClaudeSessionImport")(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const ledgerPath = path.join(config.stateDir, "claude-imports.json");

  const fail = (detail: string) => (cause: unknown) => new ClaudeImportError({ detail, cause });
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4;

  const readLedger: Effect.Effect<ImportLedger> = fileSystem.readFileString(ledgerPath).pipe(
    Effect.map((text) => decodeLedger(text)),
    // A missing or unreadable ledger means "nothing imported yet".
    Effect.orElseSucceed((): ImportLedger => ({})),
  );
  const writeLedger = (ledger: ImportLedger) =>
    fileSystem
      .writeFileString(ledgerPath, encodeLedger(ledger))
      .pipe(Effect.mapError(fail("Could not record the import ledger.")));

  /** `~/.claude/projects`, honoring a custom Claude home from settings. */
  const transcriptsDir = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(fail("Server settings could not be read.")),
    );
    const home = yield* resolveClaudeHomePath(current.providers.claudeAgent).pipe(
      Effect.provideService(Path.Path, path),
    );
    const nested = path.join(home, ".claude", "projects");
    const nestedExists = yield* fileSystem.exists(nested).pipe(Effect.orElseSucceed(() => false));
    return nestedExists ? nested : path.join(home, "projects");
  });

  /** Last user/assistant message time in a transcript, from its tail. */
  const readLastMessageMs = (file: string, size: bigint) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(file, { flag: "r" });
        const tail = size < BigInt(TAIL_BYTES) ? size : BigInt(TAIL_BYTES);
        yield* handle.seek(size - tail, "start");
        const bytes = yield* handle.readAlloc(tail);
        return Option.match(bytes, {
          onNone: () => null,
          onSome: (buffer) => lastMessageTimeMs(new TextDecoder().decode(buffer)),
        });
      }),
    );

  /** Transcript files whose last message falls inside the range. */
  const listTranscripts = Effect.fn("ClaudeSessionImport.listTranscripts")(function* (
    root: string,
    range: ClaudeImportRange,
  ) {
    const window = RANGE_MS[range];
    const nowMs = yield* Clock.currentTimeMillis;
    const sinceMs = window === null ? 0 : nowMs - window;
    const files: Array<string> = [];
    const exists = yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return files;
    const slugs = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.mapError(fail("Could not read Claude Code's session folder.")));
    for (const slug of slugs) {
      const dir = path.join(root, slug);
      // Session files rotate and vanish mid-walk; a partial listing beats a failed one.
      const names = yield* fileSystem
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        const info = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const mtimeMs = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        if (mtimeMs < sinceMs) continue;
        const last = yield* readLastMessageMs(file, info.value.size).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (last !== null && last >= sinceMs) files.push(file);
      }
    }
    return files.sort();
  });

  const skipReason = Effect.fn("ClaudeSessionImport.skipReason")(function* (cwd: string | null) {
    if (!cwd) return "no folder recorded";
    if (cwd === "/") return "root folder";
    const exists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false));
    return exists ? null : "folder no longer exists";
  });

  /** Everything a run would import, deduped against the ledger. */
  const plan = Effect.fn("ClaudeSessionImport.plan")(function* (input: ClaudeImportInput) {
    const root = yield* transcriptsDir;
    const files = yield* listTranscripts(root, input.range);
    const ledger = yield* readLedger;
    const bySession = new Map<string, Array<ClaudeTranscriptSession>>();
    for (const file of files) {
      const text = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.mapError(fail(`Could not read ${path.basename(file)}.`)));
      const parsed = parseClaudeTranscript(text, path.basename(file, ".jsonl"));
      if (!parsed) continue;
      const group = bySession.get(parsed.sessionId) ?? [];
      group.push(parsed);
      bySession.set(parsed.sessionId, group);
    }
    const sessions: Array<PlannedSession> = [];
    let alreadyImported = 0;
    let skippedNoFolder = 0;
    for (const group of bySession.values()) {
      const session = mergeClaudeSessions(group);
      if (ledger[session.sessionId]) {
        alreadyImported += 1;
        continue;
      }
      if ((yield* skipReason(session.cwd)) !== null) {
        skippedNoFolder += 1;
        continue;
      }
      sessions.push({ session, workspaceRoot: session.cwd! });
    }
    sessions.sort((a, b) => Date.parse(a.session.createdAt) - Date.parse(b.session.createdAt));

    const snapshot = yield* projections
      .getSnapshot()
      .pipe(Effect.mapError(fail("Could not read the project list.")));
    const existingProjectIds = new Map(
      snapshot.projects.map((project) => [project.workspaceRoot, project.id] as const),
    );
    const summaries = new Map<string, ClaudeImportProjectSummary>();
    for (const { session, workspaceRoot } of sessions) {
      const summary = summaries.get(workspaceRoot) ?? {
        workspaceRoot,
        title: path.basename(workspaceRoot) || "Imported",
        sessions: 0,
        messages: 0,
        isNew: !existingProjectIds.has(workspaceRoot),
      };
      summaries.set(workspaceRoot, {
        ...summary,
        sessions: summary.sessions + 1,
        messages: summary.messages + session.messages.length,
      });
    }
    const projects = [...summaries.values()].sort((a, b) => b.sessions - a.sessions);
    const summary: ClaudeImportPlan = {
      sessions: sessions.length,
      messages: sessions.reduce((n, entry) => n + entry.session.messages.length, 0),
      projects,
      newProjects: projects.filter((project) => project.isNew).length,
      alreadyImported,
      skippedNoFolder,
    };
    return { summary, sessions, existingProjectIds };
  });

  // Anything not already a ClaudeImportError (a stray filesystem failure)
  // becomes one at the service boundary so the wire type stays honest.
  const asImportError = (error: unknown) =>
    isClaudeImportError(error) ? error : fail("The import hit an unexpected error.")(error);

  const scan = Effect.fn("ClaudeSessionImport.scan")(function* (input: ClaudeImportInput) {
    return yield* plan(input).pipe(
      Effect.map((planned) => planned.summary),
      Effect.mapError(asImportError),
    );
  });

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(Effect.mapError(fail("Adly refused an import command.")));

  const importAll = Effect.fn("ClaudeSessionImport.importAll")(function* (
    input: ClaudeImportInput,
    emit: (event: ClaudeImportProgressEvent) => Effect.Effect<boolean>,
  ) {
    const { summary, sessions, existingProjectIds } = yield* plan(input);
    const projectIds = new Map(existingProjectIds);
    // Mutable copy: one entry lands per session, then the whole thing is written.
    const ledger: Record<string, { threadId: string; importedAt: string }> = {
      ...(yield* readLedger),
    };
    let sessionsDone = 0;
    let messagesDone = 0;
    let newProjects = 0;
    const progress = (currentProject: string) =>
      emit({
        type: "progress",
        sessionsDone,
        sessionsTotal: summary.sessions,
        messagesDone,
        messagesTotal: summary.messages,
        currentProject,
      });
    for (const { session, workspaceRoot } of sessions) {
      const projectTitle = path.basename(workspaceRoot) || "Imported";
      yield* progress(projectTitle);
      let projectId = projectIds.get(workspaceRoot);
      if (projectId === undefined) {
        projectId = ProjectId.make(yield* newId);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* newId),
          projectId,
          title: projectTitle,
          workspaceRoot,
          createdAt: session.createdAt,
        });
        projectIds.set(workspaceRoot, projectId);
        newProjects += 1;
      }
      const threadId = ThreadId.make(yield* newId);
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(yield* newId),
        threadId,
        projectId,
        title: session.title,
        modelSelection: { instanceId: input.instanceId, model: "claude-fable-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: session.createdAt,
      });
      for (let index = 0; index < session.messages.length; index += MESSAGES_PER_COMMAND) {
        const chunk = session.messages.slice(index, index + MESSAGES_PER_COMMAND);
        const messages = [];
        for (const message of chunk) {
          messages.push({
            messageId: MessageId.make(yield* newId),
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
          });
        }
        yield* dispatch({
          type: "thread.messages.import",
          commandId: CommandId.make(yield* newId),
          threadId,
          messages,
        });
        messagesDone += chunk.length;
        yield* progress(projectTitle);
      }
      const importedAt = DateTime.formatIso(yield* DateTime.now);
      ledger[session.sessionId] = { threadId, importedAt };
      yield* writeLedger(ledger);
      sessionsDone += 1;
    }
    yield* emit({
      type: "complete",
      sessions: sessionsDone,
      messages: messagesDone,
      newProjects,
    });
  });

  /** Runs the import, streaming progress; ends with a `complete` event. */
  const run = (input: ClaudeImportInput) =>
    Stream.callback<ClaudeImportProgressEvent, ClaudeImportError>((queue) =>
      importAll(input, (event) => Queue.offer(queue, event)).pipe(
        Effect.mapError(asImportError),
        Effect.andThen(Queue.end(queue)),
        Effect.catch((error) => Queue.fail(queue, error)),
        Effect.forkScoped,
      ),
    );

  return { scan, run } as const;
});
