import type { StoredEvent } from './types.js';

export const LEDGER_SOCKET_PROTOCOL = 'ledger.v1';

export type SocketUrlProvider = (afterVersion: number) => string;

export type SocketResyncReason = 'gap_too_large' | 'cursor_ahead';

export type SocketFrame =
    | { type: 'event'; event: StoredEvent }
    | { type: 'ready'; headVersion: number }
    | { type: 'resync_required'; headVersion: number; reason: SocketResyncReason }
    | { type: 'error'; code: string };

export enum SocketState {
    CLOSED = 'CLOSED',
    CONNECTING = 'CONNECTING',
    OPEN = 'OPEN',
    READY = 'READY',
    RECONNECTING = 'RECONNECTING',
    PAUSED = 'PAUSED',
    ERROR = 'ERROR',
}

export class SocketProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SocketProtocolError';
    }
}

export interface EventSocketConfig {
    afterVersion?: number;
    urlProvider: SocketUrlProvider;
    autoReconnect?: boolean;
    webSocketFactory?: (url: string, protocol: string) => WebSocket;
    random?: () => number;
    isOnline?: () => boolean;
    isVisible?: () => boolean;
}

type HandlerMap = {
    event: (event: StoredEvent) => void;
    ready: (headVersion: number) => void;
    resync_required: (headVersion: number, reason: SocketResyncReason) => void;
    error: (error: Error) => void;
    close: (event?: CloseEvent) => void;
    open: () => void;
};

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export class EventSocket {
    private readonly config: Required<
        Pick<EventSocketConfig, 'autoReconnect' | 'webSocketFactory' | 'random' | 'isOnline' | 'isVisible'>
    > & EventSocketConfig;
    private readonly handlers: { [K in keyof HandlerMap]: Set<HandlerMap[K]> } = {
        event: new Set(),
        ready: new Set(),
        resync_required: new Set(),
        error: new Set(),
        close: new Set(),
        open: new Set(),
    };

    private socket: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectionGeneration = 0;
    private reconnectAttempt = 0;
    private state = SocketState.CLOSED;
    private intentionallyStopped = true;
    private paused = false;
    private waitingForResync = false;
    private receivedVersion: number;
    private acknowledgedVersion: number;

    constructor(config: EventSocketConfig) {
        const afterVersion = assertVersion(config.afterVersion ?? 0, 'afterVersion');
        this.receivedVersion = afterVersion;
        this.acknowledgedVersion = afterVersion;
        this.config = {
            ...config,
            autoReconnect: config.autoReconnect ?? true,
            webSocketFactory:
                config.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol)),
            random: config.random ?? Math.random,
            isOnline:
                config.isOnline ??
                (() => typeof navigator === 'undefined' || navigator.onLine !== false),
            isVisible:
                config.isVisible ??
                (() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
        };
    }

    on<K extends keyof HandlerMap>(event: K, handler: HandlerMap[K]): this {
        this.handlers[event].add(handler);
        return this;
    }

    off<K extends keyof HandlerMap>(event: K, handler: HandlerMap[K]): this {
        this.handlers[event].delete(handler);
        return this;
    }

    async open(): Promise<void> {
        this.intentionallyStopped = false;
        this.paused = false;
        if (this.waitingForResync || this.socket) return;
        if (!this.canConnect()) {
            this.state = SocketState.PAUSED;
            return;
        }
        await this.connect();
    }

    close(): void {
        this.intentionallyStopped = true;
        this.paused = false;
        this.waitingForResync = false;
        this.connectionGeneration++;
        this.cancelReconnect();
        const socket = this.socket;
        this.socket = null;
        if (socket && socket.readyState < 2) {
            socket.close(1000, 'client shutdown');
        }
        this.state = SocketState.CLOSED;
    }

    pause(): void {
        this.paused = true;
        this.connectionGeneration++;
        this.cancelReconnect();
        const socket = this.socket;
        this.socket = null;
        if (socket && socket.readyState < 2) {
            socket.close(1000, 'client paused');
        }
        this.state = SocketState.PAUSED;
    }

    async resume(): Promise<void> {
        if (this.intentionallyStopped || this.waitingForResync) return;
        this.paused = false;
        await this.open();
    }

    isReady(): boolean {
        return this.state === SocketState.READY;
    }

    isOpen(): boolean {
        return this.state === SocketState.OPEN || this.state === SocketState.READY;
    }

    getState(): SocketState {
        return this.state;
    }

    getAcknowledgedVersion(): number {
        return this.acknowledgedVersion;
    }

    acknowledge(version: number): void {
        const next = assertVersion(version, 'acknowledged version');
        if (next > this.acknowledgedVersion) this.acknowledgedVersion = next;
    }

    resetAfterVersion(version: number): void {
        const next = assertVersion(version, 'reset version');
        this.acknowledgedVersion = next;
        this.receivedVersion = next;
        this.waitingForResync = false;
        this.reconnectAttempt = 0;
        this.state = SocketState.CLOSED;
    }

    private connect(): void {
        const generation = ++this.connectionGeneration;
        try {
            const url = this.config.urlProvider(this.acknowledgedVersion);
            validateSocketUrl(url);
            const socket = this.config.webSocketFactory(url, LEDGER_SOCKET_PROTOCOL);
            this.socket = socket;
            this.receivedVersion = this.acknowledgedVersion;
            this.state = SocketState.CONNECTING;
            socket.onopen = () => this.handleOpen(generation, socket);
            socket.onmessage = (event) => this.handleMessage(generation, socket, event.data);
            socket.onerror = () =>
                this.emit('error', new Error('Ledger WebSocket transport error'));
            socket.onclose = (event) => this.handleClose(generation, socket, event);
        } catch (cause) {
            if (!this.isCurrent(generation)) return;
            this.state = SocketState.ERROR;
            this.emit('error', asError(cause));
            this.scheduleReconnect();
        }
    }

    private handleOpen(generation: number, socket: WebSocket): void {
        if (!this.isSocketCurrent(generation, socket)) return;
        if (socket.protocol !== LEDGER_SOCKET_PROTOCOL) {
            this.protocolFailure(socket, `Expected ${LEDGER_SOCKET_PROTOCOL} subprotocol`);
            return;
        }
        this.state = SocketState.OPEN;
        this.emit('open');
    }

    private handleMessage(generation: number, socket: WebSocket, data: unknown): void {
        if (!this.isSocketCurrent(generation, socket)) return;
        try {
            if (typeof data !== 'string') throw new SocketProtocolError('Binary frames are unsupported');
            let parsed: unknown;
            try {
                parsed = JSON.parse(data) as unknown;
            } catch {
                throw new SocketProtocolError('Invalid JSON frame');
            }
            const frame = validateFrame(parsed);
            switch (frame.type) {
                case 'event':
                    if (frame.event.version > this.receivedVersion + 1) {
                        throw new SocketProtocolError(
                            `Non-contiguous event: expected ${this.receivedVersion + 1}, received ${frame.event.version}`,
                        );
                    }
                    if (frame.event.version > this.receivedVersion) {
                        this.receivedVersion = frame.event.version;
                    }
                    this.emit('event', frame.event);
                    break;
                case 'ready':
                    if (frame.headVersion < this.receivedVersion) {
                        throw new SocketProtocolError('ready head is behind received events');
                    }
                    this.reconnectAttempt = 0;
                    this.state = SocketState.READY;
                    this.emit('ready', frame.headVersion);
                    break;
                case 'resync_required':
                    this.waitingForResync = true;
                    this.state = SocketState.PAUSED;
                    this.emit('resync_required', frame.headVersion, frame.reason);
                    socket.close(1000, 'HTTP resynchronization');
                    break;
                case 'error':
                    throw new SocketProtocolError(`Server protocol error: ${frame.code}`);
            }
        } catch (cause) {
            this.protocolFailure(socket, asError(cause));
        }
    }

    private protocolFailure(socket: WebSocket, cause: string | Error): void {
        this.state = SocketState.ERROR;
        this.emit('error', typeof cause === 'string' ? new SocketProtocolError(cause) : cause);
        socket.close(1002, 'protocol error');
    }

    private handleClose(generation: number, socket: WebSocket, event: CloseEvent): void {
        if (!this.isSocketCurrent(generation, socket)) return;
        this.socket = null;
        if (!this.waitingForResync) this.state = SocketState.CLOSED;
        this.emit('close', event);
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (
            !this.config.autoReconnect ||
            this.intentionallyStopped ||
            this.paused ||
            this.waitingForResync ||
            !this.canConnect() ||
            this.reconnectTimer
        ) {
            if (!this.canConnect() && !this.intentionallyStopped) this.state = SocketState.PAUSED;
            return;
        }
        const base = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt++;
        const jitter = 0.8 + this.config.random() * 0.4;
        const delay = Math.min(30_000, Math.round(base * jitter));
        this.state = SocketState.RECONNECTING;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.canConnect()) this.connect();
            else this.state = SocketState.PAUSED;
        }, delay);
    }

    private canConnect(): boolean {
        return this.config.isOnline() && this.config.isVisible();
    }

    private isCurrent(generation: number): boolean {
        return generation === this.connectionGeneration && !this.intentionallyStopped;
    }

    private isSocketCurrent(generation: number, socket: WebSocket): boolean {
        return this.isCurrent(generation) && this.socket === socket;
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private emit<K extends keyof HandlerMap>(
        event: K,
        ...args: Parameters<HandlerMap[K]>
    ): void {
        for (const handler of this.handlers[event]) {
            try {
                (handler as (...values: Parameters<HandlerMap[K]>) => void)(...args);
            } catch (cause) {
                console.error(`[EventSocket] ${event} handler failed`, cause);
            }
        }
    }
}

function validateSocketUrl(value: string): void {
    if (
        typeof value !== 'string' ||
        (!value.startsWith('wss:') && !value.startsWith('ws:'))
    ) {
        throw new SocketProtocolError('Invalid Ledger WebSocket URL');
    }
}

function validateFrame(value: unknown): SocketFrame {
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new SocketProtocolError('Invalid frame envelope');
    }
    switch (value.type) {
        case 'event':
            if (!isStoredEvent(value.event)) throw new SocketProtocolError('Invalid event frame');
            return { type: 'event', event: value.event };
        case 'ready':
            return { type: 'ready', headVersion: assertVersion(value.headVersion, 'headVersion') };
        case 'resync_required':
            if (value.reason !== 'gap_too_large' && value.reason !== 'cursor_ahead') {
                throw new SocketProtocolError('Invalid resynchronization reason');
            }
            return {
                type: 'resync_required',
                headVersion: assertVersion(value.headVersion, 'headVersion'),
                reason: value.reason,
            };
        case 'error':
            if (typeof value.code !== 'string' || value.code.length === 0) {
                throw new SocketProtocolError('Invalid error frame');
            }
            return { type: 'error', code: value.code };
        default:
            throw new SocketProtocolError(`Unknown frame type: ${value.type}`);
    }
}

function isStoredEvent(value: unknown): value is StoredEvent {
    return (
        isRecord(value) &&
        isVersion(value.version) &&
        value.version > 0 &&
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.type === 'string' &&
        value.type.length > 0 &&
        typeof value.entityId === 'string' &&
        value.entityId.length > 0 &&
        isVersion(value.entityVersion) &&
        value.entityVersion > 0 &&
        isVersion(value.timestamp) &&
        isRecord(value.payload)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertVersion(value: unknown, name: string): number {
    if (!isVersion(value)) throw new SocketProtocolError(`${name} must be a nonnegative safe integer`);
    return value;
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function createEventSocket(config: EventSocketConfig): EventSocket {
    return new EventSocket(config);
}
