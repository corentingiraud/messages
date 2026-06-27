import { ConfigRetrieve200, useConfigRetrieve } from "@/features/api/gen";
import { refreshWebPushSubscription } from "@/features/layouts/components/mailbox-settings/devices-view/web-push";
import { Spinner } from "@gouvfr-lasuite/ui-kit";
import {
  PropsWithChildren,
  createContext,
  useContext,
  useEffect,
  useMemo,
} from "react";

type AppConfig = Omit<ConfigRetrieve200, 'DRIVE'> & Required<Pick<ConfigRetrieve200, 'DRIVE'>>;

const DEFAULT_DRIVE_CONFIG: NonNullable<ConfigRetrieve200['DRIVE']> = {
    sdk_url: "",
    api_url: "",
    file_url: "",
    preview_url: "",
    app_name: "Drive",
}

const DEFAULT_CONFIG: AppConfig = {
    ENVIRONMENT: "",
    LANGUAGES: [],
    LANGUAGE_CODE: "",
    AI_ENABLED: false,
    FEATURE_AI_SUMMARY: false,
    FEATURE_AI_AUTOLABELS: false,
    FEATURE_MAILBOX_ADMIN_CHANNELS: [],
    SCHEMA_CUSTOM_ATTRIBUTES_USER: {},
    SCHEMA_CUSTOM_ATTRIBUTES_MAILDOMAIN: {},
    MAX_OUTGOING_ATTACHMENT_SIZE: 0,
    MAX_OUTGOING_BODY_SIZE: 0,
    MAX_INCOMING_EMAIL_SIZE: 0,
    MAX_RECIPIENTS_PER_MESSAGE: 0,
    MAX_TEMPLATE_IMAGE_SIZE: 0,
    IMAGE_PROXY_ENABLED: false,
    FEATURE_MAILDOMAIN_CREATE: true,
    FEATURE_MAILDOMAIN_MANAGE_ACCESSES: true,
    FEATURE_MAILDOMAIN_MANAGE_TOTP: false,
    FEATURE_THREAD_SPLIT: true,
    DRIVE: DEFAULT_DRIVE_CONFIG,
    MESSAGES_MANUAL_RETRY_MAX_AGE: 0,
    FRONTEND_SILENT_LOGIN_ENABLED: false,
    PUSH_ENABLED: false,
    PUSH_VAPID_PUBLIC_KEY: null,
}

const ConfigContext = createContext<AppConfig>(DEFAULT_CONFIG)

/**
 * A global provider in charge of fetching the config at first load
 * and sharing it to the app.
 */
export const ConfigProvider = ({ children }: PropsWithChildren) => {
    const { data: config, isFetched } = useConfigRetrieve();
    const configValue = useMemo(() => {
      if (!config) return DEFAULT_CONFIG;
      return {
        ...config?.data,
        DRIVE: config?.data?.DRIVE ?? DEFAULT_DRIVE_CONFIG,
      }
    }, [config])

    // Self-heal web push on load: if the user previously enabled it in this
    // browser, re-register the current subscription so a rotated endpoint
    // doesn't silently stop delivering. Passive — no-ops unless a subscription
    // already exists. See refreshWebPushSubscription.
    useEffect(() => {
      if (!configValue.PUSH_ENABLED || !configValue.PUSH_VAPID_PUBLIC_KEY) return;
      refreshWebPushSubscription(configValue.PUSH_VAPID_PUBLIC_KEY);
    }, [configValue.PUSH_ENABLED, configValue.PUSH_VAPID_PUBLIC_KEY]);

    if (!isFetched) {
        return (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100vh",
            }}
          >
            <Spinner size="xl"/>
          </div>
        );
      }

    return (
        <ConfigContext.Provider value={configValue}>
            {children}
        </ConfigContext.Provider>
    )
}

export const useConfig = () => {
    const config = useContext(ConfigContext)
    if (!config) {
        throw new Error("`useConfig` must be used within a children of `ConfigProvider`.")
    }
    return config
}
