import {afterEach, describe, expect, it, vi} from "vitest";
import {DispatcherReadJournal, type DispatcherReadRecord} from "./dispatcher-read-journal.js";
import {readDispatcherReceiptStatus} from "./dispatcher-read-status.js";

const ID="00000000-0000-4000-8000-000000000601", NOW=Date.parse("2026-10-11T09:44:15.000Z");
const env={DISPATCHER_TOKEN:"synthetic-producer",CF_ACCESS_CLIENT_ID:"synthetic-access-id",CF_ACCESS_CLIENT_SECRET:"synthetic-access-secret"};
const identity={ownerHash:"12345678",workflowHash:"a".repeat(64),payloadHash:"b".repeat(64)};
function storage(record?:DispatcherReadRecord) {
  const values=new Map<string,unknown>(record ? [[`dispatcher-read:${identity.payloadHash}`,record]]:[]);
  type Store={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;
    transaction<T>(fn:(value: Store)=>Promise<T>):Promise<T>};
  const store: Store={get:async <T>(key:string)=>structuredClone(values.get(key)) as T|undefined,
    put:async(key:string,value:unknown)=>{values.set(key,structuredClone(value));},
    transaction:async<T>(fn:(value: Store)=>Promise<T>):Promise<T>=>fn(store)};
  return {values,store};
}
function saved():DispatcherReadRecord {return {version:1,...identity,generation:1,invocationId:"synthetic-invocation",
  idempotencyKey:`superops-mcp:read:${ID}`,requestId:ID,state:"queued",createdAt:new Date(NOW).toISOString(),
  updatedAt:new Date(NOW).toISOString(),delivered:false,history:[]};}
const statusRequest=(patch={})=>new Request("https://ledger.internal/dispatcher-reads/status",{method:"POST",body:JSON.stringify({
  ...identity,requestId:ID,deadlineAt:new Date(NOW+900_000).toISOString(),...patch})});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("private original read readiness",()=>{
  it("uses one credentialed GET, returns no body/key/headers, and does not alter journal delivery or generation",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {values,store}=storage(saved());
    const network=vi.fn(async(_url:string,_options:RequestInit)=>Response.json({requestId:ID,source:"superops-mcp",type:"read",status:"retry_wait",httpStatus:200,
      nextRetryAt:new Date(NOW+143_015).toISOString(),errorClassification:"RATE_LIMITED",response:{data:{private:"synthetic-body"}},
      lastError:"synthetic private message"},{headers:{"Retry-After":"120"}}));vi.stubGlobal("fetch",network);
    const result=await (await new DispatcherReadJournal(store,env).fetch(statusRequest())).json();
    expect(result).toEqual({requestId:ID,state:"retry_wait",nextEligibleAt:new Date(NOW+143_015).toISOString(),
      errorClassification:"RATE_LIMITED",deadlineAt:new Date(NOW+900_000).toISOString()});
    expect(network).toHaveBeenCalledTimes(1);
    const [url,options]=network.mock.calls[0];
    expect(url).toBe(`https://superops-api-dispatcher.taskgroup.co.uk/v1/requests/${ID}`);
    expect(options).toMatchObject({method:"GET",redirect:"manual",headers:{"X-Source":"superops-mcp",Authorization:"Bearer synthetic-producer"}});
    expect(options.body).toBeUndefined();expect(values.get(`dispatcher-read:${identity.payloadHash}`)).toEqual(saved());
    expect(JSON.stringify(result)).not.toMatch(/synthetic|lastError|response|idempotency|Authorization/);
  });
  it.each([{ownerHash:"87654321"},{workflowHash:"c".repeat(64)},{payloadHash:"c".repeat(64)},
    {requestId:"foreign"},{deadlineAt:new Date(NOW+901_000).toISOString()},{query:"synthetic"}])("refuses uncorrelated status identity before any GET: %j",async patch=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {store}=storage(saved());const network=vi.fn();vi.stubGlobal("fetch",network);
    expect((await new DispatcherReadJournal(store,env).fetch(statusRequest(patch))).status).toBe(409);expect(network).not.toHaveBeenCalled();
  });
  it("stops at the fixed deadline without polling or renewing the original record",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW+900_000);const {values,store}=storage(saved());const network=vi.fn();vi.stubGlobal("fetch",network);
    expect(await (await new DispatcherReadJournal(store,env).fetch(statusRequest())).json()).toEqual({requestId:ID,state:"expired",deadlineAt:new Date(NOW+900_000).toISOString()});
    expect(network).not.toHaveBeenCalled();expect(values.get(`dispatcher-read:${identity.payloadHash}`)).toEqual(saved());
  });
  it.each([{requestId:"foreign"},{source:"dashboard"},{type:"mutation"},{status:"invalid"},
    {httpStatus:500},{errorClassification:"GRAPHQL_ERROR"}])("an invalid or foreign success never releases the wait: %j",async patch=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({requestId:ID,source:"superops-mcp",type:"read",status:"succeeded",httpStatus:200,...patch})));
    expect(await readDispatcherReceiptStatus(ID,env)).toEqual({requestId:ID,state:"unavailable"});
  });
  it.each(["failed","cancelled","uncertain"])("retains terminal %s without a POST",async state=>{
    const network=vi.fn(async()=>Response.json({requestId:ID,source:"superops-mcp",type:"read",status:state,httpStatus:200}));vi.stubGlobal("fetch",network);
    expect(await readDispatcherReceiptStatus(ID,env)).toEqual({requestId:ID,state});expect(network).toHaveBeenCalledTimes(1);
  });
  it("rejects redirects and unavailable or oversized responses without following or retrying",async()=>{
    for(const response of [new Response(null,{status:302,headers:{Location:"https://untrusted.example"}}),
      new Response("{invalid",{status:200}),new Response("x".repeat(4*1024*1024+1))]) {
      const network=vi.fn(async()=>response);vi.stubGlobal("fetch",network);
      expect(await readDispatcherReceiptStatus(ID,env)).toEqual({requestId:ID,state:"unavailable"});expect(network).toHaveBeenCalledTimes(1);
    }
  });
});
