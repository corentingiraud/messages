import { useCallback, useRef, useState } from "react";

export type LongPressPosition = { x: number; y: number };

type UseLongPressOptions = {
  /** Delay before the press is considered "long", in milliseconds. */
  delay?: number;
  /** Haptic feedback duration when the long press fires, or false to disable. */
  vibrate?: number | false;
};

type CapacitorHaptics = { impact?: (options: { style: string }) => Promise<unknown> };

/**
 * Fire a haptic pulse when the platform exposes one: the Capacitor Haptics
 * plugin if the native app bundles it (covers iOS, which has no Web Vibration
 * API), otherwise the Web Vibration API (Android). Accessed off the global
 * Capacitor proxy so the build keeps working when the plugin isn't installed.
 */
const triggerHaptic = (fallbackMs: number) => {
  const haptics = (
    globalThis as unknown as {
      Capacitor?: { Plugins?: { Haptics?: CapacitorHaptics } };
    }
  ).Capacitor?.Plugins?.Haptics;
  if (haptics?.impact) {
    void Promise.resolve(haptics.impact({ style: "MEDIUM" })).catch(() => {});
    return;
  }
  navigator.vibrate?.(fallbackMs);
};

type UseLongPressResult = {
  handlers: {
    onTouchStart: (event: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchMove: () => void;
    onTouchCancel: () => void;
  };
  /** True while the finger is down and the long-press timer is still running. */
  pressing: boolean;
};

/**
 * Detects a touch long-press and reports the initial touch position so callers
 * can anchor a context menu where the finger landed. Touch coordinates are
 * captured on `touchstart` (the synthetic event is not retained) and any move
 * or release before the delay cancels the gesture.
 */
export const useLongPress = (
  onLongPress: (position: LongPressPosition) => void,
  { delay = 500, vibrate = 50 }: UseLongPressOptions = {},
): UseLongPressResult => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressing, setPressing] = useState(false);

  const cancel = useCallback(() => {
    setPressing(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(
    (event: React.TouchEvent) => {
      const touch = event.touches[0];
      const position: LongPressPosition = touch
        ? { x: touch.clientX, y: touch.clientY }
        : { x: 0, y: 0 };
      setPressing(true);
      timer.current = setTimeout(() => {
        setPressing(false);
        if (vibrate) triggerHaptic(vibrate);
        onLongPress(position);
      }, delay);
    },
    [delay, vibrate, onLongPress],
  );

  return {
    handlers: {
      onTouchStart: start,
      onTouchEnd: cancel,
      onTouchMove: cancel,
      onTouchCancel: cancel,
    },
    pressing,
  };
};

export default useLongPress;
