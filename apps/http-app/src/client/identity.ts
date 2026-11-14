let pageUser: string | undefined;
export async function resolveUser(signal?: AbortSignal): Promise<string> {
    const response = await globalThis.fetch('/api/identity', {cache: 'no-store', signal});
    if (!response.ok) throw new Error('Cannot verify certificate user; reload after checking certificate enrollment');
    const identity = await response.json() as {userId?: unknown};
    if (typeof identity.userId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(identity.userId)) throw new Error('Invalid certificate user');
    if (pageUser !== undefined && pageUser !== identity.userId) throw new Error('Certificate user changed; reload this page before continuing');
    pageUser = identity.userId;
    return identity.userId;
}
