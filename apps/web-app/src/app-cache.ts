/** Retire the old all-request cache; production caches only the versioned app shell. */
export async function configureAppCache(development: boolean): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    const script = new URL('./sw.js', document.baseURI);
    if (development) {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
            const worker = registration.active ?? registration.waiting ?? registration.installing;
            if (worker?.scriptURL === script.href) await registration.unregister();
        }
        if ('caches' in globalThis) await caches.delete('x1-v1');
        return;
    }
    const registration = await navigator.serviceWorker.register(script, { updateViaCache: 'none' });
    await registration.update();
}
