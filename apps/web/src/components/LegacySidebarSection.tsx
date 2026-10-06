import type { ReactNode } from "react";
import { MorphIcon } from "morphicons/react";
import { useLegacySidebarListAnimation } from "./LegacySidebar.animation";
import { SidebarGroup } from "./ui/sidebar";
import type { LegacySidebarSection as Section } from "./LegacySidebar.logic";

export function LegacySidebarSection(props: {
  section: Section;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { section, label, expanded, onToggle, actions, children } = props;
  const contentId = `legacy-sidebar-section-${section}`;
  const attachListAutoAnimateRef = useLegacySidebarListAnimation();
  return (
    <SidebarGroup>
      <div className="group/section-header mb-1 flex min-h-6 items-center gap-1 pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={onToggle}
          data-thread-selection-safe
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch text-left text-xs font-medium text-sidebar-muted-foreground/80 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{label}</span>
          <MorphIcon
            aria-hidden="true"
            icon={expanded ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"}
            spring="snappy"
            reducedMotion="user"
            className="size-3.5 shrink-0 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/section-header:opacity-100 group-focus-within/section-header:opacity-100"
          />
        </button>
        {actions}
      </div>
      <div id={contentId} ref={attachListAutoAnimateRef} className="overflow-hidden">
        {expanded ? <div>{children}</div> : null}
      </div>
    </SidebarGroup>
  );
}
