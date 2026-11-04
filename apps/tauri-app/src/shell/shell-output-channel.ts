import { Channel } from '@tauri-apps/api/core';
import type { NativeShellOptions } from '@itookit/tools';

export function shellOutputChannel(onOutput?: NativeShellOptions['onOutput']) {
    if (!onOutput) return { channel: undefined, close() {} };
    const channel = new Channel<{ stream: 'stdout' | 'stderr'; data: number[] }>();
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let closed = false;
    channel.onmessage = chunk => {
        if (!closed && onOutput) onOutput({ stream: chunk.stream, text: decoders[chunk.stream].decode(new Uint8Array(chunk.data), { stream: true }) });
    };
    return { channel, close() {
        closed = true;
        for (const stream of ['stdout', 'stderr'] as const) {
            const text = decoders[stream].decode(); if (text) onOutput?.({ stream, text });
        }
    } };
}
