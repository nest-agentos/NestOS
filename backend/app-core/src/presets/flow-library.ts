import {essayReview} from '../resources/catalog';
import {ankiGenerate} from '../resources/catalog';
import type { FlowDraft } from '@nestos/llm-flow/contracts';
import type { Drawer } from '@nestos/app-contracts';

/** Host templates are copied so consumers cannot mutate the shared product catalog. */
export function createNestosFlowLibrary(): FlowDraft[] {
    return [essayReview, ankiGenerate].map(template => structuredClone(template) as unknown as FlowDraft);
}

/** Default organization is product data; user assignments remain authoritative. */
export function createNestosFlowDrawers(): Drawer[] {
    return [];
}
