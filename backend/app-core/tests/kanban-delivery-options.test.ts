import {expect,it,vi} from 'vitest';
import {currentDeliveryRecord} from '../src/presets/kanban-delivery-options';
it('uses live delivery amendments only for new operation inputs and retains the original frozen context',async()=>{
 const original={context:{decision:{sourceBoardId:'source',recordId:'decision',snapshot:{title:'Original',verificationLevel:'none',deliveryMode:'build'}},delivery:{manualAfter:'build'}}} as any;
 const amendment={verificationLevel:'none',deliveryMode:'release',revision:4},service={record:vi.fn(async()=>({deliveryOptions:amendment}))};
 const next=await currentDeliveryRecord(service as never,original);expect(service.record).toHaveBeenCalledWith('source','decision');
 expect(next.context).toMatchObject({decision:{snapshot:{title:'Original',deliveryOptions:amendment}}});expect(original.context.decision.snapshot).not.toHaveProperty('deliveryOptions');
 expect(next).not.toBe(original);
});
