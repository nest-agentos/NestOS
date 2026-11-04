import type { Server } from 'node:http';

/** Reject listener errors instead of leaving integration setup pending until its timeout. */
export async function listenForTest(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mock server did not bind');
    return address.port;
}
