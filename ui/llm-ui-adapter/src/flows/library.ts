import type { FlowDraft } from '@nestos/llm-flow/contracts';
import type { ICommandBus } from '@nestos/llm-session/contracts';
import { FlowLibraryCommand } from '@nestos/app-contracts';

/** Explicit user action; restore only missing files and retain installation receipts. */
export async function restoreFlowLibrary(commands: ICommandBus, library: readonly FlowDraft[]): Promise<number> {
    if (!library.length) return 0;
    return commands.execute<number>(FlowLibraryCommand.Restore, { templates: structuredClone(library) });
}
