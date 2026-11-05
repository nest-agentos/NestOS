import {directAgentPolicy as preset} from '../resources/catalog';
import type { DirectAgentPolicy } from '@nestos/llm-session/contracts';

/** NestOS chooses the execution guidance and budget; Session only transmits them. */
export function createNestosDirectAgentPolicy(): DirectAgentPolicy { return structuredClone(preset); }
