import type {JsonValue} from '@nestos/llm-flow/contracts';

/** Browser files end at this host staging port; Flow values contain verified JSON references. */
export interface FlowFileAssetPort {importFile(file: File, signal?: AbortSignal): Promise<JsonValue>}
