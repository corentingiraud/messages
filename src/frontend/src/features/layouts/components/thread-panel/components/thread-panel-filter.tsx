import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "@gouvfr-lasuite/cunningham-react";
import { ContextMenu, Icon, IconType, useContextMenuContext } from "@gouvfr-lasuite/ui-kit";
import type { MenuItem } from "@gouvfr-lasuite/ui-kit";
import { THREAD_SELECTED_FILTERS_KEY } from "@/features/config/constants";
import { useMailboxContext } from "@/features/providers/mailbox";
import { isNativePlatform } from "@/features/native/platform";
import { useLongPress } from "@/hooks/use-long-press";
import {
  DEFAULT_SELECTED_FILTERS,
  THREAD_PANEL_FILTER_PARAMS,
  useThreadPanelFilters,
  type FilterType,
} from "../hooks/use-thread-panel-filters";

const getStoredSelectedFilters = (): FilterType[] => {
  try {
    const stored = JSON.parse(
      localStorage.getItem(THREAD_SELECTED_FILTERS_KEY) ?? "[]",
    );
    if (Array.isArray(stored) && stored.length > 0) {
      const validFilters = stored.filter(
        (value): value is FilterType =>
          typeof value === "string" &&
          THREAD_PANEL_FILTER_PARAMS.includes(value as FilterType),
      );
      if (validFilters.length > 0) {
        return validFilters;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_SELECTED_FILTERS;
};

export const ThreadPanelFilter = () => {
  const { t } = useTranslation();
  const [selectedFilters, setSelectedFilters] =
    useState<FilterType[]>(getStoredSelectedFilters);

  const { threads } = useMailboxContext();
  const { hasActiveFilters, activeFilters, applyFilters, clearFilters } =
    useThreadPanelFilters();
  const { open } = useContextMenuContext();
  const isNative = isNativePlatform();
  // A long press fires a click on release; this guard skips the quick-toggle
  // that would otherwise run right after the menu opens.
  const longPressFiredRef = useRef(false);
  const isDisabled = !threads?.results.length && !hasActiveFilters;

  const filterLabels: Record<FilterType, string> = useMemo(
    () => ({
      has_unread: t("Unread"),
      has_starred: t("Starred"),
      has_mention: t("Mentioned"),
      has_assigned_to_me: t("Assigned to me"),
    }),
    [t],
  );

  const filterMenuItems: MenuItem[] = THREAD_PANEL_FILTER_PARAMS.map((type) => ({
    label: filterLabels[type],
    icon: (
      <Icon
        name={selectedFilters.includes(type) ? "check_box" : "check_box_outline_blank"}
        type={IconType.OUTLINED}
      />
    ),
    callback: () => handleSelectFilter(type),
  }));

  const { handlers: longPressHandlers } = useLongPress((position) => {
    longPressFiredRef.current = true;
    open({ position, items: filterMenuItems });
  });

  const handleToggleClick = () => {
    // Ignore the synthetic click that follows a long press: the menu just opened.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (hasActiveFilters) {
      clearFilters();
    } else {
      applyFilters(selectedFilters);
    }
  };

  const handleSelectFilter = (type: FilterType) => {
    const toggled = selectedFilters.includes(type)
      ? selectedFilters.filter((f) => f !== type)
      : [...selectedFilters, type];
    const next = toggled.length > 0 ? toggled : DEFAULT_SELECTED_FILTERS;
    setSelectedFilters(next);
    localStorage.setItem(THREAD_SELECTED_FILTERS_KEY, JSON.stringify(next));
    if (hasActiveFilters) {
      applyFilters(next);
    }
  };

  const getTooltipContent = () => {
    if (hasActiveFilters) {
      const active = THREAD_PANEL_FILTER_PARAMS.filter(
        (param) => activeFilters[param],
      );
      return t("Active filters: {{filters}}", {
        filters: active.map((f) => filterLabels[f]).join(", "),
      });
    }
    return t("Filter by: {{filters}}", {
      filters: selectedFilters.map((f) => filterLabels[f]).join(", "),
    });
  };

  const trigger = (
    <Tooltip
      placement="right"
      content={getTooltipContent()}
      className={isDisabled ? "hidden" : ""}
    >
      <Button
        onClick={handleToggleClick}
        disabled={isDisabled}
        icon={<Icon name="filter_list" type={IconType.OUTLINED} />}
        variant={hasActiveFilters ? "secondary" : "tertiary"}
        size="medium"
        aria-label={t("Filter threads")}
      />
    </Tooltip>
  );

  // Touch devices have no right-click/double-tap to summon the context menu, so
  // on the native app a long press opens it imperatively. On desktop the menu
  // stays wired to the ContextMenu wrapper (right-click / keyboard).
  if (isNative) {
    return (
      <span className="thread-panel__filter-trigger" {...longPressHandlers}>
        {trigger}
      </span>
    );
  }

  return <ContextMenu options={filterMenuItems}>{trigger}</ContextMenu>;
};
