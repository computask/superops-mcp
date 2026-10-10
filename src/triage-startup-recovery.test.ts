import { describe, expect, it } from "vitest";
import { emptyStartupCaptures, inspectedStartupProof } from "./triage-startup-recovery.js";

const proof = {conversationId:"00000000-0000-4000-8000-000000000001",complete:true,workflowStepCount:0,toolCallCount:0,
  elicitationCount:0,denialObserved:false,providerErrorCode:"hermes_gpt_run_failed",providerErrorSubcode:"failed_during_run",providerCanRetry:true};
const page = {complete:true,hasMore:false,totalRecords:0,captureFailureCount:0,incompleteRecordCount:0,truncated:false,records:[]};
describe("operator startup proof",()=>{
  it("requires complete inspected provider proof and independent empty capture corroboration",()=>{
    expect(inspectedStartupProof(proof)).toBe(true);expect(emptyStartupCaptures(page)).toBe(true);
    expect(inspectedStartupProof(page)).toBe(false);
  });
  it.each([{complete:false},{workflowStepCount:1},{toolCallCount:1},{elicitationCount:1},{denialObserved:true},
    {providerErrorCode:"permission_denied"},{providerErrorSubcode:"unknown"},{providerCanRetry:false},{extra:"synthetic private content"}])("rejects incomplete, active or denied proof %j",change=>{
    expect(inspectedStartupProof({...proof,...change})).toBe(false);
  });
  it.each([{complete:false},{hasMore:true},{totalRecords:1},{captureFailureCount:1},{incompleteRecordCount:1},
    {truncated:true},{records:[{}]},{records:undefined}])("rejects missing or non-empty captures %j",change=>{
    expect(emptyStartupCaptures({...page,...change})).toBe(false);
  });
});
