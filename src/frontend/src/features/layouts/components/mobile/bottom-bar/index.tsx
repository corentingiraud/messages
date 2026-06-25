import { PropsWithChildren } from "react";
import { createPortal } from "react-dom";

type MobileBottomBarProps = PropsWithChildren<{
  /** Extra class on the inner bar, to vary layout per usage. */
  className?: string;
}>;

/**
 * Floating bar pinned to the bottom of the viewport on the native app.
 *
 * Rendered through a portal to `document.body` so it stays viewport-fixed
 * regardless of transformed ancestors (resizable panels, sliding left panel).
 */
export const MobileBottomBar = ({ children, className }: MobileBottomBarProps) => {
  return createPortal(
    <div className={`mobile-bottom-bar${className ? ` ${className}` : ""}`}>
      {children}
    </div>,
    document.body,
  );
};

export default MobileBottomBar;
