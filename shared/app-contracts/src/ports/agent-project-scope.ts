/** Host policy uses immutable project identities, independently of portable Agent definitions. */
export type AgentProjectScope = {kind: 'all'} | {kind: 'selected'; projectIds: string[]};
