export function fileWindowLabel(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return (parts.at(-2) ?? 'root') + '-' + parts.at(-1);
}
