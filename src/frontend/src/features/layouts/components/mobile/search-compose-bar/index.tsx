import { useTranslation } from "react-i18next";
import { Button } from "@gouvfr-lasuite/cunningham-react";
import { Icon, IconType } from "@gouvfr-lasuite/ui-kit";
import { SearchInput } from "@/features/forms/components/search-input";
import { ThreadPanelFilter } from "@/features/layouts/components/thread-panel/components/thread-panel-filter";
import { useComposeMessage } from "@/features/message/use-compose-message";
import { isNativePlatform } from "@/features/native/platform";
import { MobileBottomBar } from "../bottom-bar";

/**
 * Native-only bottom bar for the thread-list view: quick filter, search field,
 * and a thumb-reachable compose button — laid out left to right.
 */
export const MobileSearchComposeBar = () => {
  const { t } = useTranslation();
  const { canWriteMessages, goToNewMessage, selectedMailbox } = useComposeMessage();

  if (!isNativePlatform() || !selectedMailbox) return null;

  return (
    <MobileBottomBar className="mobile-search-compose-bar">
      <ThreadPanelFilter />
      <div className="mobile-search-compose-bar__search">
        <SearchInput />
      </div>
      <Button
        className="mobile-search-compose-bar__compose"
        onClick={goToNewMessage}
        href={`/mailbox/${selectedMailbox.id}/new`}
        icon={<Icon name="edit_note" type={IconType.OUTLINED} aria-hidden="true" />}
        disabled={!canWriteMessages}
        aria-label={t("New message")}
      />
    </MobileBottomBar>
  );
};

export default MobileSearchComposeBar;
