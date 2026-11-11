import {formatDateTime} from '@nestos/ui-common';
// @file: llm-ui/utils/timeUtils.ts

/** Absolute timestamps share the browser-local display with an explicit UTC offset. */
export function formatTime(timestamp: number): string {
    return formatDateTime(timestamp);
}

/** Relative time-ago string: "just now", "5m ago", "2h ago", "7d ago", or locale date. */
export function formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    return formatDateTime(timestamp);
}
