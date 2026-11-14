export function flowIdFromNodeId(nodeId: string | undefined): string | null {
    const base = nodeId?.split('/').pop() ?? '';
    return base.toLowerCase().endsWith('.flow') ? base.slice(0, -5) || null : null;
}
