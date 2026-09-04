import type {
  ClaudeImportPlan,
  ClaudeImportProgressEvent,
  ClaudeImportRange,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";

const RANGES: ReadonlyArray<{ value: ClaudeImportRange; label: string }> = [
  { value: "1w", label: "Last week" },
  { value: "2w", label: "Last 2 weeks" },
  { value: "1m", label: "Last month" },
  { value: "3m", label: "Last 3 months" },
  { value: "all", label: "Everything" },
];

type Step =
  | { kind: "choose" }
  | { kind: "scanning" }
  | { kind: "review"; plan: ClaudeImportPlan }
  | { kind: "running"; progress: Extract<ClaudeImportProgressEvent, { type: "progress" }> | null }
  | { kind: "done"; result: Extract<ClaudeImportProgressEvent, { type: "complete" }> }
  | { kind: "failed"; detail: string };

/**
 * "Import from Claude Code" on the Claude provider card: pick a time range,
 * confirm what would come across, watch it land. Threads appear in the
 * sidebar as they import because the server writes them through the normal
 * command path.
 */
export function ClaudeImportSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<ClaudeImportRange>("2w");
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const scan = useAtomCommand(serverEnvironment.scanClaudeImport, { reportFailure: false });
  const run = useAtomCommand(serverEnvironment.runClaudeImport, { reportFailure: false });

  const reset = useCallback(() => setStep({ kind: "choose" }), []);
  const close = useCallback(
    (next: boolean) => {
      if (!next && step.kind === "running") return;
      setOpen(next);
      if (!next) reset();
    },
    [reset, step.kind],
  );

  const handleScan = useCallback(async () => {
    setStep({ kind: "scanning" });
    const result = await scan({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, range },
    });
    if (result._tag === "Success") {
      setStep({ kind: "review", plan: result.value });
    } else {
      setStep({ kind: "failed", detail: describeFailure(result) });
    }
  }, [props.environmentId, props.instanceId, range, scan]);

  const handleRun = useCallback(async () => {
    setStep({ kind: "running", progress: null });
    const result = await run({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        range,
        onProgress: (event) => {
          if (event.type === "progress") setStep({ kind: "running", progress: event });
        },
      },
    });
    if (result._tag === "Success" && result.value._tag === "Some") {
      const complete = result.value.value;
      if (complete.type === "complete") {
        setStep({ kind: "done", result: complete });
        return;
      }
    }
    setStep({
      kind: "failed",
      detail:
        result._tag === "Success"
          ? "The import ended before it finished."
          : describeFailure(result),
    });
  }, [props.environmentId, props.instanceId, range, run]);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Import from Claude Code</p>
        <p className="text-xs text-muted-foreground">
          Bring your terminal sessions into Adly as threads. Claude Code's files are only read.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.readOnly}
        onClick={() => setOpen(true)}
      >
        <DownloadIcon className="size-3.5" />
        Import
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogPopup className="max-w-lg">
          <DialogPanel>
            <DialogHeader>
              <DialogTitle>Import from Claude Code</DialogTitle>
              <DialogDescription>
                Sessions become threads under the project folder they ran in. Your Claude Code
                history stays exactly where it is; nothing there is changed or moved.
              </DialogDescription>
            </DialogHeader>

            {step.kind === "choose" || step.kind === "scanning" ? (
              <div className="flex flex-col gap-3 py-2">
                <p className="text-sm">Sessions with a message in:</p>
                <RadioGroup
                  value={range}
                  onValueChange={(value) => setRange(value as ClaudeImportRange)}
                  className="flex flex-col gap-1.5"
                >
                  {RANGES.map((option) => (
                    <label key={option.value} className="flex items-center gap-2 text-sm">
                      <Radio value={option.value} />
                      {option.label}
                    </label>
                  ))}
                </RadioGroup>
              </div>
            ) : null}

            {step.kind === "review" ? <PlanSummary plan={step.plan} /> : null}

            {step.kind === "running" ? <RunProgress progress={step.progress} /> : null}

            {step.kind === "done" ? (
              <div className="flex flex-col gap-1 py-2 text-sm">
                <p className="font-medium">Done</p>
                <p className="text-muted-foreground">
                  {step.result.sessions} {plural(step.result.sessions, "thread")} with{" "}
                  {step.result.messages} {plural(step.result.messages, "message")} imported
                  {step.result.newProjects > 0
                    ? `, ${step.result.newProjects} new ${plural(step.result.newProjects, "project")} added`
                    : ""}
                  . They are in the sidebar now.
                </p>
              </div>
            ) : null}

            {step.kind === "failed" ? (
              <div className="flex flex-col gap-1 py-2 text-sm">
                <p className="font-medium text-destructive">Import stopped</p>
                <p className="text-muted-foreground">{step.detail}</p>
                <p className="text-muted-foreground">
                  Anything that finished before this is already in the sidebar; running again picks
                  up where it left off.
                </p>
              </div>
            ) : null}

            <DialogFooter>
              {step.kind === "choose" || step.kind === "scanning" ? (
                <>
                  <Button type="button" variant="ghost" onClick={() => close(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleScan()}
                    disabled={step.kind === "scanning"}
                  >
                    {step.kind === "scanning" ? "Looking…" : "Continue"}
                  </Button>
                </>
              ) : null}
              {step.kind === "review" ? (
                <>
                  <Button type="button" variant="ghost" onClick={reset}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleRun()}
                    disabled={step.plan.sessions === 0}
                  >
                    Import {step.plan.sessions} {plural(step.plan.sessions, "session")}
                  </Button>
                </>
              ) : null}
              {step.kind === "running" ? (
                <Button type="button" disabled>
                  Importing…
                </Button>
              ) : null}
              {step.kind === "done" || step.kind === "failed" ? (
                <Button type="button" onClick={() => close(false)}>
                  Close
                </Button>
              ) : null}
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function PlanSummary({ plan }: { readonly plan: ClaudeImportPlan }) {
  if (plan.sessions === 0) {
    return (
      <div className="py-2 text-sm text-muted-foreground">
        Nothing new to import in this range.
        {plan.alreadyImported > 0
          ? ` ${plan.alreadyImported} ${plural(plan.alreadyImported, "session")} already imported.`
          : ""}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 py-2 text-sm">
      <p>
        <span className="font-medium">
          {plan.sessions} {plural(plan.sessions, "session")}
        </span>
        , {plan.messages} {plural(plan.messages, "message")}, across {plan.projects.length}{" "}
        {plural(plan.projects.length, "project")}
        {plan.newProjects > 0 ? ` (${plan.newProjects} new)` : ""}.
      </p>
      <ul className="max-h-56 overflow-y-auto rounded-md border border-border/60 text-xs">
        {plan.projects.map((project) => (
          <li
            key={project.workspaceRoot}
            className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{project.title}</span>
            {project.isNew ? <span className="text-muted-foreground">new</span> : null}
            <span className="tabular-nums text-muted-foreground">
              {project.sessions} {plural(project.sessions, "session")}
            </span>
          </li>
        ))}
      </ul>
      {plan.alreadyImported > 0 || plan.skippedNoFolder > 0 ? (
        <p className="text-xs text-muted-foreground">
          {plan.alreadyImported > 0 ? `${plan.alreadyImported} already imported. ` : ""}
          {plan.skippedNoFolder > 0
            ? `${plan.skippedNoFolder} skipped: their folder no longer exists.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

function RunProgress({
  progress,
}: {
  readonly progress: Extract<ClaudeImportProgressEvent, { type: "progress" }> | null;
}) {
  const fraction =
    progress && progress.messagesTotal > 0 ? progress.messagesDone / progress.messagesTotal : 0;
  return (
    <div className="flex flex-col gap-2 py-2 text-sm">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full bg-primary transition-[width] duration-200")}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {progress
          ? `${progress.sessionsDone} of ${progress.sessionsTotal} sessions, ${progress.messagesDone} of ${progress.messagesTotal} messages · ${progress.currentProject}`
          : "Starting…"}
      </p>
    </div>
  );
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function describeFailure(result: { readonly _tag: string; readonly error?: unknown }): string {
  const error = result.error;
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong while talking to the server.";
}
