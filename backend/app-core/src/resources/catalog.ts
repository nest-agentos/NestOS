import development from './kanban/kanban-development-prompts.json';
import maintenance from './kanban/kanban-maintenance-prompts.json';
import readme from './notes/notes-readme.json';
import demo from './notes/digital-twin-demo.json';
import flowGuide from './notes/flow-format-guide.json';

/** Shared declarations for installation, upgrade, explicit recovery and execution snapshots. */
export const kanbanConfigurationDefaults={...development,...maintenance};
export const noteResources=[{id:'note:readme',...readme},{id:'note:demo',...demo},{id:'note:flow-format',...flowGuide}];
export {default as developmentPrompts} from './kanban/kanban-development-prompts.json';
export {default as kanbanDemo} from './kanban/kanban-demo.json';
export {default as kanbanDiscovery} from './kanban/kanban-discovery.json';
export {default as kanbanFixPolicy} from './kanban/kanban-fix.json';
export {default as studyPrompts} from './study/study-prompts.json';
export {default as studyNotes} from './study/study-notes.json';
export {default as essayReview} from './flows/essay-review.json';
export {default as ankiGenerate} from './flows/anki-generate.json';
export {default as directAgentPolicy} from './agents/direct-agent.json';
