import { useEffect, useRef, useState } from "react";

type UsePullToRefreshOptions = {
    /** Triggered when the pull crosses the threshold; its promise drives the spinner. */
    onRefresh: () => Promise<unknown>;
    /** When false the gesture is never attached (e.g. non-native platforms). */
    enabled?: boolean;
    /** Distance in px the user must pull past to trigger a refresh. */
    threshold?: number;
};

type UsePullToRefreshResult = {
    /**
     * Callback ref to set on the scrollable container. Using a callback ref
     * (rather than reading a ref object in the effect) guarantees the listeners
     * are attached as soon as the element actually mounts — the container is
     * rendered behind a loading state, so an effect keyed on stable deps would
     * otherwise never see it.
     */
    containerRef: (node: HTMLElement | null) => void;
    /** Current visual pull distance in px (damped and capped). */
    pullDistance: number;
    /** True while onRefresh is in flight. */
    isRefreshing: boolean;
    /** True while the finger drives the pull (used to disable the release animation). */
    isActive: boolean;
};

/** Damping applied to the raw finger travel so the pull feels elastic. */
const RESISTANCE = 0.5;
/** Hard cap on the visual pull distance. */
const MAX_PULL = 120;

/**
 * Attach a top pull-to-refresh gesture to a scrollable element.
 *
 * The gesture only arms when the container is scrolled to the very top, so it
 * never competes with normal scrolling or bottom infinite-scroll. It relies on
 * raw touch events with a non-passive `touchmove` listener so the browser's
 * native overscroll can be prevented while pulling.
 */
export const usePullToRefresh = ({
    onRefresh,
    enabled = true,
    threshold = 70,
}: UsePullToRefreshOptions): UsePullToRefreshResult => {
    const [container, setContainer] = useState<HTMLElement | null>(null);
    const [pullDistance, setPullDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isActive, setIsActive] = useState(false);

    // Refs mirror the values read inside the long-lived event handlers, so the
    // listeners stay stable and don't capture stale state.
    const startYRef = useRef(0);
    const armedRef = useRef(false);
    const distanceRef = useRef(0);
    const refreshingRef = useRef(false);
    const onRefreshRef = useRef(onRefresh);
    onRefreshRef.current = onRefresh;

    useEffect(() => {
        if (!enabled || !container) {
            return;
        }
        const el = container;

        const setDistance = (value: number) => {
            distanceRef.current = value;
            setPullDistance(value);
        };

        const onTouchStart = (event: TouchEvent) => {
            if (refreshingRef.current || el.scrollTop > 0) {
                armedRef.current = false;
                return;
            }
            startYRef.current = event.touches[0].clientY;
            armedRef.current = true;
            setIsActive(true);
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!armedRef.current || refreshingRef.current) {
                return;
            }
            const delta = event.touches[0].clientY - startYRef.current;
            if (delta <= 0) {
                if (distanceRef.current !== 0) {
                    setDistance(0);
                }
                return;
            }
            // Claim the gesture: stop the native rubber-band so the indicator
            // follows the finger smoothly.
            event.preventDefault();
            setDistance(Math.min(delta * RESISTANCE, MAX_PULL));
        };

        const onTouchEnd = () => {
            setIsActive(false);
            if (!armedRef.current) {
                return;
            }
            armedRef.current = false;
            if (distanceRef.current < threshold) {
                setDistance(0);
                return;
            }
            refreshingRef.current = true;
            setIsRefreshing(true);
            setDistance(threshold);
            void Promise.resolve(onRefreshRef.current()).finally(() => {
                refreshingRef.current = false;
                setIsRefreshing(false);
                setDistance(0);
            });
        };

        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd);
        el.addEventListener("touchcancel", onTouchEnd);

        return () => {
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchEnd);
        };
    }, [container, enabled, threshold]);

    return { containerRef: setContainer, pullDistance, isRefreshing, isActive };
};
