import { useTranslation } from "react-i18next";
import { Button } from "@gouvfr-lasuite/cunningham-react";
import { Icon, IconType } from "@gouvfr-lasuite/ui-kit";
import { Thread } from "@/features/api/gen/models";
import { useMailboxContext } from "@/features/providers/mailbox";
import { useThreadViewContext } from "@/features/layouts/components/thread-view/provider";
import useArchive from "@/features/message/use-archive";
import useStarred from "@/features/message/use-starred";
import useAbility, { Abilities } from "@/hooks/use-ability";
import { isNativePlatform } from "@/features/native/platform";
import { MobileBottomBar } from "../bottom-bar";

type MobileThreadToolbarProps = {
  thread: Thread;
  isArchived: boolean;
  isTrashed: boolean;
};

/**
 * Native-only bottom toolbar shown while a conversation is open: the quick
 * actions Reply / Archive / Star, replacing the search bar of the list view.
 */
export const MobileThreadToolbar = ({ thread, isArchived, isTrashed }: MobileThreadToolbarProps) => {
  const { t } = useTranslation();
  const { selectedMailbox, unselectThread } = useMailboxContext();
  const { requestReply, isMessageFormFocused } = useThreadViewContext();
  const { markAsArchived, markAsUnarchived } = useArchive();
  const { markAsStarred, markAsUnstarred } = useStarred();
  const canSendMessages = useAbility(Abilities.CAN_SEND_MESSAGES, selectedMailbox);
  const canEditThread = useAbility(Abilities.CAN_EDIT_THREAD, thread);

  // While the composer is focused the BlockNote formatting toolbar takes the
  // spot above the keyboard, so step aside to avoid stacking two bars there.
  if (!isNativePlatform() || isMessageFormFocused) return null;

  const canReply = canSendMessages && canEditThread && !isTrashed;
  const isStarred = thread.has_starred;

  const archiveLabel = isArchived ? t("Unarchive") : t("Archive");
  const starLabel = isStarred ? t("Unstar") : t("Star");

  const handleArchive = () => {
    const mutation = isArchived ? markAsUnarchived : markAsArchived;
    mutation({ threadIds: [thread.id], onSuccess: () => unselectThread() });
  };

  const handleStar = () => {
    const mutation = isStarred ? markAsUnstarred : markAsStarred;
    mutation({ threadIds: [thread.id] });
  };

  return (
    <MobileBottomBar className="mobile-thread-toolbar">
      {canReply && (
        <Button
          variant="tertiary"
          onClick={() => requestReply()}
          icon={<Icon name="reply" type={IconType.OUTLINED} />}
          aria-label={t("Reply")}
        />
      )}
      <Button
        variant="tertiary"
        onClick={handleArchive}
        icon={<Icon name={isArchived ? "unarchive" : "archive"} type={IconType.OUTLINED} />}
        aria-label={archiveLabel}
      />
      <Button
        variant="tertiary"
        onClick={handleStar}
        icon={<Icon name={isStarred ? "star" : "star_border"} type={isStarred ? IconType.FILLED : IconType.OUTLINED} />}
        aria-label={starLabel}
      />
    </MobileBottomBar>
  );
};

export default MobileThreadToolbar;
