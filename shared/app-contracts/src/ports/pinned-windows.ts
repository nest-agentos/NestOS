export interface WindowTimes {
    createdAt?: number;
    modifiedAt?: number;
    accessedAt?: number;
}

export interface PinnedWindow extends WindowTimes {
    workspace: string;
    resource: string;
    title: string;
    scope?: string;
    context?: string;
    location?: string;
}

export interface PinnedWindowChange {
    operationId: string;
    window: PinnedWindow;
    pinned: boolean;
}
