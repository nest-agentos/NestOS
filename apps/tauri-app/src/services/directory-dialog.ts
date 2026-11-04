/**
 * @file apps/tauri-app/src/services/directory-dialog.ts
 * @description Native host-directory picker used by the local mount button.
 *
 * The dialog reports a cancel by resolving to `null` and a broken picker by rejecting.
 * Those two must stay distinguishable: when the rejection was swallowed, a chooser that
 * never returned a directory looked exactly like the user cancelling, and the only
 * symptom was a button that did nothing.
 */
export interface DirectoryDialogOptions {
    directory: true;
    multiple: false;
}

export type DirectoryOpener = (options: DirectoryDialogOptions) => Promise<string | string[] | null>;

const openWithPlugin: DirectoryOpener = async options =>
    (await import('@tauri-apps/plugin-dialog')).open(options) as Promise<string | string[] | null>;

/** Returns the selected host path, or `null` when the user cancelled. Rejects on failure. */
export async function openDirectoryDialog(open: DirectoryOpener = openWithPlugin): Promise<string | null> {
    try {
        const result = await open({ directory: true, multiple: false });
        return typeof result === 'string' ? result : null;
    } catch (error) {
        console.error('[Mount] Directory dialog failed:', error);
        throw error;
    }
}
