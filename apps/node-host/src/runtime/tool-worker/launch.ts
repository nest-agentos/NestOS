/** Keep the guardian free of application runtime, filesystem and business module initialization. */
export async function runToolWorker(): Promise<void> {
    if (process.env.NESTOS_TOOL_WORKER_ROLE === 'guardian') (await import('./guardian')).runToolGuardian();
    else (await import('./entry')).runToolWorker();
}
