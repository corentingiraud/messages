import { useTranslation } from "react-i18next";
import { Button } from "@gouvfr-lasuite/cunningham-react";
import { useRefreshFeedback } from "@/hooks/use-refresh-feedback";
import { useComposeMessage } from "@/features/message/use-compose-message";
import { Icon, IconType } from "@gouvfr-lasuite/ui-kit";
import { TransientTooltip } from "@/features/ui/components/transient-tooltip";
import clsx from "clsx";

export const MailboxPanelActions = () => {
    const { t } = useTranslation();
    const { canWriteMessages, goToNewMessage, selectedMailbox } = useComposeMessage();
    const { isRefreshing, feedback, clearFeedback, refresh } = useRefreshFeedback();

    if (!selectedMailbox) return null;

    return (
        <div className="mailbox-panel-actions">
            <div>
                <Button
                    onClick={goToNewMessage}
                    href={`/mailbox/${selectedMailbox.id}/new`}
                    icon={<Icon name="edit_note" type={IconType.OUTLINED} aria-hidden="true" />}
                    disabled={!canWriteMessages}
                >
                    {t("New message")}
                </Button>
            </div>
            <div className="mailbox-panel-actions__extra">
                <TransientTooltip
                    message={feedback}
                    onHide={clearFeedback}
                    placement="bottom"
                >
                    <Button
                        icon={
                            <Icon
                                name="autorenew"
                                className={clsx(
                                    "mailbox-panel-actions__refresh-icon",
                                    { "mailbox-panel-actions__refresh-icon--spinning": isRefreshing }
                                )}
                                aria-hidden="true"
                            />
                        }
                        variant="tertiary"
                        aria-label={isRefreshing ? t("Loading…") : t("Refresh")}
                        onClick={() => void refresh()}
                        disabled={isRefreshing}
                    />
                </TransientTooltip>
            </div>
        </div>
    );
};
