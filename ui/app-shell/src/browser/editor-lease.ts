import type { IEditor } from '@nestos/ui-common-adapter';

/** Retain resources after a save failure until a save succeeds or recovery checkpoints the editor. */
export class EditorLease {
    private disposal?: Promise<void>;
    constructor(private readonly editor: IEditor | undefined, private readonly release: () => Promise<void>) {}
    dispose(recovering = false): Promise<void> {
        return this.disposal ??= this.disposeNow(recovering);
    }
    private async disposeNow(recovering: boolean): Promise<void> {
        try { await Promise.resolve().then(() => this.editor?.destroy()); }
        catch (error) { if (!recovering) {this.disposal = undefined; throw error;} }
        await this.release();
    }
}
