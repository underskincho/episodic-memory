interface EventLike {
    type?: string;
}
interface EventIterable {
    [Symbol.asyncIterator]: () => AsyncIterator<EventLike>;
}
interface PluginContext {
    options?: Record<string, unknown>;
    event?: {
        subscribe: (options?: {
            types?: string[];
        }) => EventIterable;
    };
}
type PluginCleanup = () => void | Promise<void>;
export declare function buildSyncArgs(summaryLimit: number): string[];
export declare function setup(ctx: PluginContext): Promise<PluginCleanup>;
declare const _default: {
    id: string;
    setup: typeof setup;
};
export default _default;
