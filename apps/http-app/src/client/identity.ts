let pageUser: string | undefined;
const userHintKey = 'nestos.authenticated-user';
export function authenticatedUserHint(): string | undefined {
    try {
        const value = sessionStorage.getItem(userHintKey);
        return validUser(value) ? value : undefined;
    } catch {return undefined;}
}
export function rememberAuthenticatedUser(userId?: string): void {
    try {
        if (userId) sessionStorage.setItem(userHintKey, userId);
        else sessionStorage.removeItem(userHintKey);
    } catch { /* Cache storage is optional. */ }
}
function validUser(userId: unknown): userId is string {
    return typeof userId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(userId);
}
export async function resolveUser(signal?: AbortSignal): Promise<string> {
    const response = await globalThis.fetch('/api/identity', {cache: 'no-store', signal});
    if (!response.ok) throw new Error('Cannot verify certificate user; reload after checking certificate enrollment');
    const identity = await response.json() as {userId?: unknown};
    return acceptAuthenticatedUser(identity.userId);
}
export function acceptAuthenticatedUser(userId:unknown):string {
    if(!validUser(userId))throw new Error('Invalid certificate user');
    if(pageUser!==undefined&&pageUser!==userId)throw new Error('Certificate user changed; reload this page before continuing');
    return pageUser=userId;
}
