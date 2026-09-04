import { ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarProjectSectionAttention } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";

// Same hues the thread rows use for these states, so the dot on a collapsed
// header means exactly what the label it stands in for would.
const ATTENTION_DOT_CLASS: Record<SidebarProjectSectionAttention, string> = {
  failed: "bg-red-600 dark:bg-red-400",
  approval: "bg-amber-600 dark:bg-amber-400",
  input: "bg-indigo-500 dark:bg-indigo-400",
  working: "bg-sky-500 dark:bg-sky-400",
};

const ATTENTION_LABEL: Record<SidebarProjectSectionAttention, string> = {
  failed: "A thread failed",
  approval: "A thread needs approval",
  input: "A thread needs input",
  working: "A thread is working",
};

// Rows hang off a rail hugging the left edge; the rail is the only structure
// the section adds, the header itself is just a line of text.
const RAIL_CLASS = "ms-1.5 border-s border-sidebar-border/70 ps-1";

/**
 * One section of the sidebar inbox: a flat project line that toggles its
 * thread rows. With `project` null the section is headerless and always
 * open (single-project scope, or the rare thread whose project is unknown).
 *
 * Children are `<li>` rows. While collapsed the parent hands over only the
 * open thread's row (if any), which renders below the header outside the
 * animated panel so the route never hides.
 */
export function SidebarProjectSection(props: {
  project: SidebarProjectSnapshot | null;
  expanded: boolean;
  threadCount: number;
  attention: SidebarProjectSectionAttention | null;
  onToggle: (projectKey: string) => void;
  onOpenSettings: (
    event: ReactMouseEvent<HTMLButtonElement>,
    project: SidebarProjectSnapshot,
  ) => void;
  onNewThread: (project: SidebarProjectSnapshot) => void;
  attachList: (node: HTMLUListElement | null) => void;
  children: ReactNode;
}) {
  const { project, expanded, threadCount, attention, onToggle, attachList, children } = props;
  if (project === null) {
    return (
      <li className="list-none">
        <ul ref={attachList} role="list" className="flex flex-col gap-px">
          {children}
        </ul>
      </li>
    );
  }

  const rows = (
    <ul ref={attachList} role="list" className={cn("flex flex-col gap-px", RAIL_CLASS)}>
      {children}
    </ul>
  );

  return (
    <li className="list-none pt-2 first:pt-0" data-thread-selection-safe>
      <Collapsible open={expanded} onOpenChange={() => onToggle(project.projectKey)}>
        <div className="group/section-header flex h-7 items-center gap-0.5 pe-1">
          <CollapsibleTrigger
            aria-label={`${expanded ? "Collapse" : "Expand"} ${project.displayName}`}
            data-testid="sidebar-project-section-toggle"
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md ps-[var(--sidebar-row-content-inset)] pe-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.workspaceRoot}
              projectName={project.displayName}
              faviconPath={project.faviconPath}
              projectIcon={project.projectIcon}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-secondary-label transition-colors group-hover/section-header:text-foreground">
              {project.displayName}
            </span>
            {!expanded && attention ? (
              <span
                role="img"
                aria-label={ATTENTION_LABEL[attention]}
                className={cn("size-1.5 shrink-0 rounded-full", ATTENTION_DOT_CLASS[attention])}
              />
            ) : null}
          </CollapsibleTrigger>
          {/* Count and gear take no width at rest, so the name keeps it; on
              hover (or keyboard focus inside) they slide open and the name
              yields. The plus is always there: it is the row's verb. */}
          <span className="flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity] duration-150 group-focus-within/section-header:max-w-24 group-focus-within/section-header:opacity-100 group-hover/section-header:max-w-24 group-hover/section-header:opacity-100 motion-reduce:transition-none">
            {!expanded ? (
              <span className="shrink-0 px-1 text-xs tabular-nums text-secondary-label/80">
                {threadCount}
              </span>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Project settings for ${project.displayName}`}
              title={`Project settings for ${project.displayName}`}
              className="size-6 shrink-0 [--control-icon-color:currentColor] text-icon-muted"
              onClick={(event) => props.onOpenSettings(event, project)}
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`New thread in ${project.displayName}`}
                  className="size-6 shrink-0 [--control-icon-color:currentColor] text-icon-muted hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onNewThread(project);
                  }}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {project.displayName}</TooltipPopup>
          </Tooltip>
          {/* Always visible; rotation alone says open or closed. */}
          <span
            aria-hidden
            onClick={() => onToggle(project.projectKey)}
            className={cn(
              "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-secondary-label/80 transition-[rotate] hover:text-foreground motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          >
            <ChevronDownIcon className="size-3.5" />
          </span>
        </div>
        {expanded ? (
          <CollapsiblePanel className="motion-reduce:transition-none">
            {threadCount === 0 ? (
              <p
                className={cn(
                  "py-1 ps-[var(--sidebar-row-content-inset)] text-xs text-sidebar-muted-foreground/70",
                  RAIL_CLASS,
                )}
              >
                No open threads
              </p>
            ) : (
              rows
            )}
          </CollapsiblePanel>
        ) : (
          rows
        )}
      </Collapsible>
    </li>
  );
}
