import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@gouvfr-lasuite/cunningham-react";
import { useMailboxContext } from "@/features/providers/mailbox";
import { useLayoutContext } from "@/features/layouts/components/layout-context";
import useAbility, { Abilities } from "@/hooks/use-ability";
import { useRefreshFeedback } from "@/hooks/use-refresh-feedback";
import { Icon, IconType } from "@gouvfr-lasuite/ui-kit";
import { TransientTooltip } from "@/features/ui/components/transient-tooltip";
import clsx from "clsx";

export const MailboxPanelActions = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { selectedMailbox } = useMailboxContext();
    const { closeLeftPanel } = useLayoutContext();
    const canWriteMessages = useAbility(Abilities.CAN_WRITE_MESSAGES, selectedMailbox);
    const { isRefreshing, feedback, clearFeedback, refresh } = useRefreshFeedback();

    const goToNewMessageForm = (event: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
        event.preventDefault();
        if (!canWriteMessages) return;
        closeLeftPanel();
        navigate({ to: '/mailbox/$mailboxId/new', params: { mailboxId: selectedMailbox!.id } });
    };

    if (!selectedMailbox) return null;

    return (
        <div className="mailbox-panel-actions">
            <div>
                <Button
                    onClick={goToNewMessageForm}
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
