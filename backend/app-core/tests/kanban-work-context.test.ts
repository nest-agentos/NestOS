import {expect,it} from 'vitest';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {workContext} from '../src/kanban/work-context';
const board={id:'development',title:'开发'} as KanbanBoard;
const item={id:'child',title:'Swipe',responsibility:'Implement swipe',acceptance:'Two clicks',planning:{parentId:'parent',dependencies:['before']},
    externalRefs:[{system:'nestos-decision-run',id:'run'},{system:'nestos-remote-project',id:'x1'},{system:'other',id:'not-a-project'}]} as KanbanItem;
it('resolves board, decision, task lineage and project identities from host facts',async()=>{
    const decision={sourceBoardId:'development',recordId:'decision',recordRevision:2,runId:'run'};
    const journal={get:async(key:string)=>key==='record-context:run'?decision:undefined} as KanbanAutomationJournal;
    expect(await workContext(journal,board,item)).toEqual({board:{id:'development',title:'开发',revision:undefined,reference:'development'},decision,
        task:{id:'child',revision:undefined,reference:'development/child',parentId:'parent',title:'Swipe',responsibility:'Implement swipe',acceptance:'Two clicks',dependencies:['before']},
        projects:[{system:'nestos-remote-project',id:'x1'}]});
});
it('recovers same-board historical provenance and never invents a decision for manual work',async()=>{
    const journal={get:async(key:string)=>key==='record-runs:development'?[{id:'run',sourceBoardId:'development',recordId:'decision',recordRevision:2}]:undefined} as KanbanAutomationJournal;
    expect((await workContext(journal,board,item)).decision?.recordId).toBe('decision');
    expect((await workContext(journal,board,{...item,externalRefs:[]})).decision).toBeNull();
});
it('passes prior approved clarification scope to a new run without treating it as current completion',async()=>{
    const data=new Map<string,unknown>([
        ['record-context:run',{sourceBoardId:'development',recordId:'decision',recordRevision:4,runId:'run',previousRunId:'old'}],
        ['record-runs:development',[{id:'run',boardId:'development',itemIds:['child'],record:{}},{id:'old',boardId:'old-board',itemIds:['old-task'],record:{}}]],
        ['analysis-current:'+JSON.stringify(['old-board','old-task']),'old-analysis'],
        ['old-analysis',{id:'prior-plan',status:{state:'ready'},result:{ready:true,reason:'Confirmed scope',dependencies:[]}}],
    ]);
    const journal={get:async(key:string)=>data.get(key)} as KanbanAutomationJournal;
    const context=await workContext(journal,board,item);
    expect(context.priorPlanning).toMatchObject({id:'prior-plan',result:{reason:'Confirmed scope'}});
    expect(context.planning).toBeUndefined();
});
