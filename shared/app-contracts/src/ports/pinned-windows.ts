export interface PinnedWindow {
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
