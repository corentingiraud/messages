import { createFileRoute } from "@tanstack/react-router";
import { useResponsive } from "@gouvfr-lasuite/ui-kit";
import { Panel, Group, Separator, useDefaultLayout } from "react-resizable-panels";

import { ThreadPanel } from "@/features/layouts/components/thread-panel";
import { ThreadSelectionPlaceholder } from "@/features/layouts/components/thread-selection-placeholder";
import { ThreadView } from "@/features/layouts/components/thread-view";
import { useThreadSelection } from "@/features/providers/thread-selection";

const Mailbox = () => {
  const { selectedThreadIds } = useThreadSelection();
  const { isMobile } = useResponsive();
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    groupId: "threads",
    storage: localStorage,
  });

  const content = selectedThreadIds.size > 0 ? (
    <ThreadSelectionPlaceholder />
  ) : (
    <ThreadView />
  );

  // On mobile the thread view takes over the whole content area in normal
  // flow (no side-by-side list, no fixed overlay).
  if (isMobile) {
    return content;
  }

  return (
    <Group defaultLayout={defaultLayout} onLayoutChange={onLayoutChange} orientation="horizontal" className="threads__container">
      <Panel id="panel-thread-list" className="thread-list-panel" defaultSize="30%" minSize="250px" maxSize="50%">
        <ThreadPanel />
      </Panel>
      <Separator className="panel__resize-handle" />
      <Panel id="panel-thread-view" className="thread-view-panel">
        {content}
      </Panel>
    </Group>
  );
};

export const Route = createFileRoute("/mailbox/$mailboxId/thread/$threadId")({
  component: Mailbox,
});
