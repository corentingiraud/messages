import { Icon, IconSize, IconType, Spinner } from "@gouvfr-lasuite/ui-kit";
import { Trash } from "@gouvfr-lasuite/ui-kit/icons";
import { Button, Column, DataGrid, useModals } from "@gouvfr-lasuite/cunningham-react";
import { useTranslation } from "react-i18next";
import { ReactNode, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
    Channel,
    useUsersMeChannelsList,
    useUsersMeChannelsDestroy,
    getUsersMeChannelsListQueryKey,
} from "@/features/api/gen";
import { useConfig } from "@/features/providers/config";
import { Banner } from "@/features/ui/components/banner";
import { addToast, ToasterItem } from "@/features/ui/components/toaster";
import { handle } from "@/features/utils/errors";
import { enableWebPush, isWebPushSupported } from "./web-push";

// Push channels store their transport in ``settings.platform`` (apns/fcm/web).
// The OS-friendly label lives here in the frontend — the backend deliberately
// keys on transport, not OS (see core.enums.PushPlatformChoices).
const getPlatformLabel = (
    platform: string | undefined,
    t: (key: string) => string,
) => {
    switch (platform) {
        case "apns":
            return t("Apple (iPhone / iPad)");
        case "fcm":
            return t("Android");
        case "web":
            return t("Web browser");
        default:
            return t("Device");
    }
};

const getPlatformIcon = (platform: string | undefined) => {
    switch (platform) {
        case "apns":
            return "phone_iphone";
        case "fcm":
            return "phone_android";
        case "web":
            return "public";
        default:
            return "notifications";
    }
};

const getChannelPlatform = (channel: Channel): string | undefined =>
    (channel.settings as { platform?: string } | null | undefined)?.platform;

/**
 * Lists the current user's registered push devices (user-scoped ``push``
 * channels), lets them enable notifications on the current browser, and sign a
 * device out. Native devices are auto-registered by the apps; the web browser is
 * enabled with the button here.
 */
export const UserDevicesGrid = () => {
    const { t } = useTranslation();
    const config = useConfig();
    const modals = useModals();
    const queryClient = useQueryClient();
    const [isEnabling, setIsEnabling] = useState(false);

    const { data, isLoading, error } = useUsersMeChannelsList();
    const { mutateAsync: deleteDevice, isPending: isDeleting } =
        useUsersMeChannelsDestroy();

    // ``/users/me/channels/`` returns every user-scoped channel; this view only
    // manages push devices.
    const devices = useMemo(
        () => (data?.data ?? []).filter((c) => c.type === "push"),
        [data],
    );

    // The current browser can be enabled only when Web Push is configured
    // server-side (VAPID public key) and the browser supports it.
    const canEnableThisBrowser =
        isWebPushSupported() && !!config.PUSH_VAPID_PUBLIC_KEY;

    const invalidateDevices = async () => {
        await queryClient.invalidateQueries({
            queryKey: getUsersMeChannelsListQueryKey(),
            exact: false,
        });
    };

    const handleEnable = async () => {
        if (!config.PUSH_VAPID_PUBLIC_KEY) {
            return;
        }
        setIsEnabling(true);
        try {
            const result = await enableWebPush(config.PUSH_VAPID_PUBLIC_KEY);
            if (result === "subscribed") {
                await invalidateDevices();
                addToast(
                    <ToasterItem type="info">
                        <span>{t("Notifications enabled on this device.")}</span>
                    </ToasterItem>,
                );
            } else {
                // One accurate message per failure mode.
                const messages: Record<string, string> = {
                    denied: t(
                        "Notifications are blocked. Allow them for this site in your browser settings.",
                    ),
                    dismissed: t(
                        "Notification permission was dismissed. Click again to enable.",
                    ),
                    unsupported: t(
                        "This browser does not support notifications.",
                    ),
                    registration_failed: t(
                        "Couldn't start the notification service worker. Reload the page and try again.",
                    ),
                    push_service_error: t(
                        "Couldn't reach the push service. If you use Brave, enable “Use Google services for push messaging” in settings, restart the browser, then try again.",
                    ),
                };
                addToast(
                    <ToasterItem type="error">
                        <span>{messages[result]}</span>
                    </ToasterItem>,
                );
            }
        } catch (err) {
            handle(err);
            addToast(
                <ToasterItem type="error">
                    <span>{t("Failed to enable notifications.")}</span>
                </ToasterItem>,
            );
        } finally {
            setIsEnabling(false);
        }
    };

    const handleSignOut = async (channel: Channel) => {
        const decision = await modals.deleteConfirmationModal({
            title: (
                <span className="c__modal__text--centered">
                    {t('Sign out "{{name}}"', { name: channel.name })}
                </span>
            ),
            children: t(
                "This device will stop receiving notifications until you enable them again on it.",
            ),
        });
        if (decision !== "delete") {
            return;
        }
        try {
            await deleteDevice({ id: channel.id });
            await invalidateDevices();
            addToast(
                <ToasterItem type="info">
                    <span>{t("Device signed out.")}</span>
                </ToasterItem>,
            );
        } catch (err) {
            handle(err);
            addToast(
                <ToasterItem type="error">
                    <span>{t("Failed to sign out device.")}</span>
                </ToasterItem>,
            );
        }
    };

    const columns: Column<Channel>[] = [
        {
            id: "name",
            headerName: t("Name"),
            renderCell: ({ row }) => (
                <div
                    className="flex-row flex-align-center"
                    style={{ gap: "var(--c--globals--spacings--xs)" }}
                >
                    <Icon
                        name={getPlatformIcon(getChannelPlatform(row))}
                        type={IconType.OUTLINED}
                        size={IconSize.SMALL}
                    />
                    <span>{row.name}</span>
                </div>
            ),
        },
        {
            id: "platform",
            headerName: t("Type"),
            size: 180,
            renderCell: ({ row }) => getPlatformLabel(getChannelPlatform(row), t),
        },
        {
            id: "last_active",
            headerName: t("Last active"),
            size: 140,
            // last_used_at is stamped on every (re)registration — relaunch /
            // token refresh — so it reflects "last active". Fall back to
            // created_at for any row that has never been stamped.
            renderCell: ({ row }) => {
                const ts = row.last_used_at ?? row.created_at;
                return ts ? new Date(ts).toLocaleDateString() : "";
            },
        },
        {
            id: "actions",
            size: 130,
            headerName: t("Actions"),
            renderCell: ({ row }) => (
                <div
                    className="flex-row flex-justify-start"
                    style={{ width: "100%", gap: "var(--c--globals--spacings--2xs)" }}
                >
                    <Button
                        color="error"
                        variant="tertiary"
                        size="nano"
                        onClick={() => handleSignOut(row)}
                        disabled={isDeleting}
                        icon={isDeleting ? <Spinner size="sm" /> : <Trash size="small" />}
                        aria-label={t("Sign out")}
                    />
                </div>
            ),
        },
    ];

    const enableToolbar = canEnableThisBrowser ? (
        <div
            className="flex-row flex-justify-end"
            style={{ marginBottom: "var(--c--globals--spacings--sm)" }}
        >
            <Button
                variant="secondary"
                size="small"
                onClick={handleEnable}
                disabled={isEnabling}
                icon={isEnabling ? <Spinner size="sm" /> : undefined}
            >
                {t("Enable notifications on this device")}
            </Button>
        </div>
    ) : null;

    let body: ReactNode;
    if (isLoading) {
        body = (
            <Banner type="info" icon={<Spinner />}>
                {t("Loading devices...")}
            </Banner>
        );
    } else if (error) {
        body = <Banner type="error">{t("Error while loading devices")}</Banner>;
    } else {
        body = (
            <DataGrid
                columns={columns}
                rows={devices}
                onSortModelChange={() => undefined}
                enableSorting={false}
                emptyPlaceholderLabel={t(
                    "No devices yet. Enable notifications on this device or in the app.",
                )}
            />
        );
    }

    return (
        <div className="admin-data-grid">
            {enableToolbar}
            {body}
        </div>
    );
};
