import {expect,it} from 'vitest';
import {kanbanReviewGuidance} from '../src/kanban/host';
it('describes replacement acceptance without claiming a deployment or enabling automatic integration',()=>{
    const guide=kanbanReviewGuidance({} as never,{externalRefs:[{system:'nestos-worktree',id:'tree'}]} as never)!;
    expect(guide.title).toContain('替换当前服务');
    const text=guide.paragraphs.join('\n');
    expect(text).toContain('先停止当前服务');expect(text).toContain('不并行启动第二份服务');
    expect(text).toContain('尚不代表人工验收通过或任务版本已上线');expect(text).toContain('确认运行版本确为本任务的验收构建');
    expect(text).toContain('不会自动 commit');expect(text).toContain('已合入主分支');
    expect(text).toContain('继续原主执行 Session');expect(text).toContain('由用户选择或修改处理方案');
    expect(text).toContain('任一变化');expect(text).toContain('不自动新建会话');
    expect(kanbanReviewGuidance({} as never,{externalRefs:[]} as never)).toBeUndefined();
});
