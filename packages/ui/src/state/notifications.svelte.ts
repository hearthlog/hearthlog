export type NotificationType = "success" | "error" | "info" | "progress";

export interface NotificationAction {
    label: string;
    run: () => void | Promise<void>;
}

export interface AppNotification {
    id: string;
    type: NotificationType;
    message: string;
    action?: NotificationAction;
    duration: number;
}

export const notificationState = $state<{ items: AppNotification[] }>({
    items: [],
});

function push(
    type: NotificationType,
    message: string,
    action?: NotificationAction,
    duration = action ? 8000 : 4500,
): string {
    const id = crypto.randomUUID();
    notificationState.items.push({ id, type, message, action, duration });
    return id;
}

export function dismissNotification(id: string): void {
    notificationState.items = notificationState.items.filter(
        (item) => item.id !== id,
    );
}

export const notify = {
    success: (message: string, action?: NotificationAction) =>
        push("success", message, action),
    error: (message: string, action?: NotificationAction) =>
        push("error", message, action, 7000),
    info: (message: string, action?: NotificationAction) =>
        push("info", message, action),
    /**
     * A sticky notification for an async task. The caller keeps the returned
     * id and dismisses it with `dismissNotification` when the task settles.
     */
    progress: (message: string) => push("progress", message, undefined, 0),
};
