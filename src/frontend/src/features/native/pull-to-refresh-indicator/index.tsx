import { Spinner } from "@gouvfr-lasuite/ui-kit";
import clsx from "clsx";

type PullToRefreshIndicatorProps = {
    /** Current pull distance in px (drives the revealed height). */
    pullDistance: number;
    /** True while the refresh is in flight. */
    isRefreshing: boolean;
    /** True while the finger drives the pull; disables the release animation. */
    isActive: boolean;
    /** Distance past which a release triggers a refresh. */
    threshold: number;
};

export const PullToRefreshIndicator = ({
    pullDistance,
    isRefreshing,
    isActive,
    threshold,
}: PullToRefreshIndicatorProps) => {
    // Kept mounted (collapsed to height 0) even at rest so the release/refresh
    // settle animates smoothly via the height transition instead of unmounting.
    const progress = Math.min(pullDistance / threshold, 1);

    return (
        <div
            className="pull-to-refresh"
            style={{
                height: pullDistance,
                transition: isActive ? "none" : "height 0.25s ease",
            }}
            aria-hidden={!isRefreshing}
        >
            <div
                className={clsx("pull-to-refresh__spinner", {
                    // Spinner stays frozen while the user drags; it only starts
                    // rotating once the refresh actually fires.
                    "pull-to-refresh__spinner--static": !isRefreshing,
                })}
                style={{ opacity: progress }}
            >
                <Spinner size="lg" />
            </div>
        </div>
    );
};
