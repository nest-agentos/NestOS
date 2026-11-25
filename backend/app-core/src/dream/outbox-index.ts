export const DREAM_OUTBOX_INDEX = '/var/lib/dream/outbox-index.seq';
export const dreamOutboxKey = (owner: string, dream: string) => `dream:${JSON.stringify([owner, dream])}`;
