// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {parseEnvironment, projectExecutionSettings} from '../src/projects/project-execution-settings';
import {projectApprovalSettings} from '../src/projects/project-approval-settings';
it('preserves literal values and rejects duplicate or malformed names', () => {
    expect(parseEnvironment('GIT_AUTHOR_NAME=Rain Li\nTOKEN=a=b\nEMPTY=\n\n')).toEqual({GIT_AUTHOR_NAME:'Rain Li', TOKEN:'a=b', EMPTY:''});
    for (const text of ['KEY=a\nKEY=b', 'MISSING', '1KEY=value']) expect(() => parseEnvironment(text)).toThrow();
});

it('renders profile labels safely and submits the originally read revision', async () => {
    const project = {id: 'p', revision: 7};
    const setExecution = vi.fn(async () => {});
    const remote = {executionSettings: async () => ({project, execution: {profile: 'dev', variables: {NAME: '<script>literal</script>'}},
        profiles: [{id: 'dev', name: '<img src=x>', user: 'li'}]}), setExecution};
    const form = await projectExecutionSettings(remote as never, 'p', new AbortController().signal);
    expect(form.panel.querySelector('img')).toBeNull();
    expect(form.panel.querySelector('textarea')!.value).toContain('<script>literal</script>');
    form.panel.querySelector('textarea')!.value = 'NAME=Changed';
    await form.save();
    expect(setExecution).toHaveBeenCalledWith('p', project, {profile: 'dev', variables: {NAME:'Changed'}}, expect.any(Object));
});

it('saves approval defaults with their own revision and no environment remount', async () => {
    const setExecution = vi.fn();
    const setHarnessApprovals = vi.fn(async () => ({revision: 3, defaults: {claude: 'allowRead'}}));
    const remote = {executionSettings: async () => ({
        project: {id: 'p', revision: 7}, execution: {profile: null, variables: {}}, profiles: [],
        harnessApprovals: {revision: 2, defaults: {codex: 'deny', agy: 'ask'}},
    }), setExecution, setHarnessApprovals};
    const form = await projectExecutionSettings(remote as never, 'p', new AbortController().signal);
    const [codex, dsh, claude, agy] = [...form.panel.querySelectorAll('fieldset select')];
    expect(codex.value).toBe('deny');
    expect([...dsh.options].map(option => option.value)).not.toContain('allowRead');
    claude.value = 'allowRead';
    expect([...agy.options].map(option => option.value)).toEqual(['ask', 'allowRead', 'allowAll', 'deny']);
    agy.value = 'allowRead';
    expect(form.requiresRemount()).toBe(false);
    await form.save();
    expect(setExecution).not.toHaveBeenCalled();
    expect(setHarnessApprovals).toHaveBeenCalledWith('p', {revision: 2, defaults: {
        codex: 'deny', dsh: 'ask', claude: 'allowRead', agy: 'allowRead',
    }}, expect.any(Object));
});

it('preserves the approval contract of nodes that have not advertised AGY', () => {
    const panel = document.createElement('div');
    const read = projectApprovalSettings(panel, {codex: 'ask'});
    expect(read()).toEqual({codex: 'ask', dsh: 'ask', claude: 'ask'});
});
