const string={type:'string'};
const projectIds={type:'array',items:string,minItems:1,maxItems:16};

export const decisionCreationMethods={
    status:{description:'Read this draft, confirmation and available actions.',inputSchema:object({})},
    propose:{description:'Preview a decision for the preselected projects. This creates no decision or tasks.',inputSchema:object({
        id:string,title:string,content:string,rationale:string,projectIds,
        verificationMode:{enum:['build-cleanup','release','quick','full','build','source'],description:'Defaults to merge, build and cleanup. Choose release, quick or full only when deployment is requested.'},
        dependsOn:{type:'array',maxItems:16,items:object({boardId:string,recordId:string},['boardId','recordId'])},
    },['id','title','content','rationale','projectIds'])},
    confirm:{description:'Create only after the real user says the exact confirmation for the current preview.',inputSchema:object({proposalDigest:string},['proposalDigest'])},
} as const;

function object(properties:Record<string,unknown>,required:string[]=[]):Record<string,unknown> {
    return {type:'object',properties,required,additionalProperties:false};
}

export function decisionCreationContext(confirmText:string) {
    return {
        requestMethod:'kanban.invoke',pluginId:'decisions',methods:decisionCreationMethods,
        initialState:'empty draft',defaultVerificationMode:'build-cleanup',confirmText,
        relatedDecisions:{method:'search',input:{query:'<relevant decision title or terms>'}},
    };
}
