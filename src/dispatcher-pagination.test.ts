import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPATCHER_ORIGIN, dispatcherFetch, DispatcherPendingError, runWithDispatcher, dispatcherIdempotencyKey, withDispatcherOperation } from "./dispatcher.js";
import { SuperOpsClient } from "./client.js";
import { assertPageBounds, fetchAllPages } from "./pagination.js";
import { executionDiagnostics, runWithExecutionConfig, runWithExecutionContext, recordSubrequestStart } from "./execution.js";
import { readFileSync } from "node:fs";
import { fetchTicketsPaginated } from "./domains/ticket-reporting.js";
import { boundedToolResult } from "./utils/tool-result.js";

const env = { DISPATCHER_TOKEN: "synthetic-producer", CF_ACCESS_CLIENT_ID: "synthetic-access", CF_ACCESS_CLIENT_SECRET: "synthetic-secret" };
const query = "query Tickets($input: ListInfoInput!) { getTicketList(input: $input) { tickets { ticketId status } listInfo { page pageSize hasMore totalCount } } }";
const receipt = (status: string, extra = {}) => ({requestId: "receipt-1", source: "superops-mcp", status, ...extra});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("dispatcher-only transport", () => {
  it("uses producer and Access authentication, source, unique idempotency and no upstream credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({data: {ok: true}})); vi.stubGlobal("fetch", fetcher);
    await runWithDispatcher(env, () => new SuperOpsClient({apiToken: "upstream-not-sent", subdomain: "tenant-not-sent"}).query("query Test { ok }"));
    expect((fetcher.mock.calls as unknown[][])[0][0]).toBe(`${DISPATCHER_ORIGIN}/graphql`);
    const init = (fetcher.mock.calls as unknown[][])[0][1] as RequestInit;
    expect(init.headers).toMatchObject({Authorization: "Bearer synthetic-producer", "X-Source": "superops-mcp", "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET, "Idempotency-Key": expect.stringMatching(/^superops-mcp:/)});
    expect(JSON.stringify(init)).not.toMatch(/upstream-not-sent|tenant-not-sent|CustomerSubDomain/);
    expect(init.redirect).toBe("manual");
  });
  it.each([undefined, "receipt-1"])("rejects redirects without following or replaying (receipt %s)", async requestId => {
    const fetcher = vi.fn(async () => new Response(null, {status:302, headers:{Location:"https://untrusted.example/private-location"}}));
    vi.stubGlobal("fetch", fetcher);
    await expect(dispatcherFetch("{}", {env, requestId, idempotencyKey:"same", mutation:true})).rejects.toMatchObject({state:"redirect_rejected", requestId});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).not.toContain("https://untrusted.example/private-location");
  });
  it.each([202, 504])("polls the same receipt after HTTP %s; never re-POSTs", async status => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(receipt("queued"), {status}))
      .mockResolvedValueOnce(Response.json(receipt("running")))
      .mockResolvedValueOnce(Response.json(receipt("succeeded", {httpStatus: 200, response: {data: {ok: true}}})));
    vi.stubGlobal("fetch", fetcher);
    const promise = dispatcherFetch("{}", {env, idempotencyKey: "superops-mcp:test"});
    await vi.runAllTimersAsync();
    expect(await (await promise).json()).toEqual({data: {ok: true}});
    expect(fetcher.mock.calls.map(c => c[1].method)).toEqual(["POST", "GET", "GET"]);
    expect(fetcher.mock.calls.slice(1).every(c => c[0] === `${DISPATCHER_ORIGIN}/v1/requests/receipt-1`)).toBe(true);
  });
  it("recovers by receipt without a new submission and counts polling in budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt("succeeded", {httpStatus: 200, response: {data: {ok: true}}}))));
    await runWithExecutionContext("recover", async () => {
      await dispatcherFetch("", {env, requestId: "receipt-1", idempotencyKey: "superops-mcp:test"});
      expect(executionDiagnostics()?.subrequests).toMatchObject({used: 1});
    });
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("GET");
  });
  it("preserves long Retry-After and a recoverable receipt, without sleeping early or resubmitting", async () => {
    const fetcher = vi.fn(async () => Response.json(receipt("retry_wait"), {status: 202, headers: {"Retry-After": "60"}}));
    vi.stubGlobal("fetch", fetcher);
    await expect(dispatcherFetch("{}", {env, idempotencyKey: "superops-mcp:test"})).rejects.toMatchObject({requestId: "receipt-1", retryAfter: 60});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not replay an ambiguous mutation or return uncertain as success", async () => {
    const fetcher = vi.fn(async () => {throw new Error("lost acknowledgement");}); vi.stubGlobal("fetch", fetcher);
    await expect(runWithDispatcher(env, () => new SuperOpsClient({apiToken: "unused", subdomain: "test"}).mutate("mutation Update { updateTicket { ticketId } }"))).rejects.toBeInstanceOf(DispatcherPendingError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([200, null])("preserves GraphQL throttling from pending receipts without replay (upstream HTTP %s)", async httpStatus => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(receipt("queued"), {status:202}))
      .mockResolvedValueOnce(Response.json(receipt("retry_wait", {httpStatus,errorClassification:"RATE_LIMITED",nextRetryAt:new Date(Date.now()+61000).toISOString()})));
    vi.stubGlobal("fetch", fetcher);
    const result=runWithDispatcher(env,()=>new SuperOpsClient({apiToken:"unused",subdomain:"test"}).query("query Test {ok}")).catch(e=>e);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({state:"pending",rateLimited:true,errorClassification:"RATE_LIMITED",httpStatus:httpStatus??undefined,requestId:"receipt-1"});
    expect(fetcher.mock.calls.map(c=>c[1].method)).toEqual(["POST","GET"]);
  });
  it("rejects receipt identity confusion and never follows a supplied URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({...receipt("succeeded"), source: "other", statusUrl: "https://evil.example/", httpStatus: 200, response: {data: {ok: true}}})));
    await expect(dispatcherFetch("", {env, requestId: "receipt-1", idempotencyKey: "same"})).rejects.toMatchObject({state: "invalid_status_identity"});
  });
  it("fails closed without producer credentials", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(dispatcherFetch("{}", {env: {}, idempotencyKey: "test"})).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps terminal rate-limit classification without re-enqueueing or leaking lastError", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(receipt("queued"), {status:202}))
      .mockResolvedValueOnce(Response.json(receipt("failed", {httpStatus:429, response:null, errorClassification:"RATE_LIMIT_EXHAUSTED", lastError:"private upstream text"})));
    vi.stubGlobal("fetch", fetcher);
    const result = runWithDispatcher(env, () => new SuperOpsClient({apiToken:"unused",subdomain:"test"}).query("query Test {ok}")).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toMatchObject({state:"failed",httpStatus:429,rateLimited:true,errorClassification:"RATE_LIMIT_EXHAUSTED",requestId:"receipt-1"});
    expect(error instanceof Error ? error.message : String(error)).not.toContain("private upstream text");
    expect(fetcher.mock.calls.map(c=>c[1].method)).toEqual(["POST","GET"]);
  });
  it("honours the durable nextRetryAt even when the status has no Retry-After header", async () => {
    vi.stubGlobal("fetch", vi.fn(async()=>Response.json(receipt("retry_wait", {nextRetryAt:new Date(Date.now()+120000).toISOString()}))));
    await expect(dispatcherFetch("",{env,requestId:"receipt-1",idempotencyKey:"same"})).rejects.toMatchObject({requestId:"receipt-1",retryAfter:120});
  });
  it.each([null, {errors:[{message:"private"}]}])("does not invent upstream HTTP 502 or success for a terminal transport timeout (%j)", async response => {
    vi.stubGlobal("fetch", vi.fn(async()=>Response.json(receipt("failed", {httpStatus:null,response,errorClassification:"TIMEOUT"}))));
    await expect(dispatcherFetch("",{env,requestId:"receipt-1",idempotencyKey:"same"})).rejects.toMatchObject({
      requestId:"receipt-1",state:"failed",httpStatus:undefined,errorClassification:"TIMEOUT",
    });
  });
  it("retains an accepted header receipt if the response body fails", async () => {
    const onReceipt=vi.fn();
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException("private","AbortError"));}}),{
      status:202,headers:{"X-Dispatcher-Request-Id":"receipt-1"},
    })));
    await expect(dispatcherFetch("{}",{env,idempotencyKey:"same",onReceipt,mutation:true})).rejects.toMatchObject({requestId:"receipt-1",state:"request_timeout"});
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({requestId:"receipt-1",state:"queued"}));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses a stable mutation key across invocations, isolated by owner, item and payload", async () => {
    const key = (scope:string,item:string,body="mutation body") => withDispatcherOperation(scope,item,()=>dispatcherIdempotencyKey(body,true));
    const first=await key("owner:operation","1");
    expect(await key("owner:operation","1")).toBe(first);
    expect(await key("other:operation","1")).not.toBe(first);
    expect(await key("owner:operation","2")).not.toBe(first);
    expect(await key("owner:operation","1","different stage")).not.toBe(first);
  });
  it("has no direct upstream transport in either production caller", () => {
    for (const file of ["client.ts", "rate-limit-probe.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/https:\/\/(?:eu)?api\.superops\.ai|CustomerSubDomain/);
      expect(text).not.toMatch(/await fetch\(/);
    }
  });
});

function fakePages(total = 350) {
  const calls: Record<string, unknown>[] = [];
  return {calls, query: async <T>(_query: string, vars?: Record<string, unknown>): Promise<T> => {
    calls.push(vars!); const input = vars!.input as {page: number; pageSize: number};
    const offset = (input.page - 1) * input.pageSize;
    return {getTicketList: {tickets: Array.from({length: Math.max(0, Math.min(input.pageSize, total-offset))}, (_, i) => ({ticketId: String(offset+i), status: "New Calls"})), listInfo: {...input, hasMore: offset+input.pageSize < total, totalCount: total}}} as T;
  }};
}
describe("complete bounded pagination", () => {
  it("fetches 350 as 100+100+100+50, in order with unchanged filters and variables", async () => {
    const client = fakePages();
    const vars = {extra: "preserve", input: {page: 1, pageSize: 100, condition: {attribute: "status", operator: "is", value: "New Calls"}, sort: [{attribute: "createdTime", order: "DESC"}]}};
    const result = await fetchAllPages<{getTicketList: {tickets: {ticketId: string}[]; complete: boolean; recordsReturned: number}}>(client, query, vars);
    expect(client.calls).toHaveLength(4);
    expect(client.calls.map(c => (c.input as {page: number}).page)).toEqual([1,2,3,4]);
    expect(result.getTicketList.complete).toBe(true);
    expect(result.getTicketList.tickets.map(t => t.ticketId)).toEqual(Array.from({length:350},(_,i)=>String(i)));
    expect(client.calls.every(c => c.extra === vars.extra && JSON.stringify((c.input as object)) .includes("New Calls"))).toBe(true);
  });
  it("caps requested pages without capping total results", async () => {
    const client = fakePages();
    await fetchAllPages(client, query, {input: {pageSize:500}});
    expect(client.calls.every(c => (c.input as {pageSize:number}).pageSize === 100)).toBe(true);
  });
  it("returns exact next page and original input on a page bound", async () => {
    const result = await fetchAllPages<{getTicketList: Record<string, unknown>}>(fakePages(), query, {input:{page:1,pageSize:100}}, {maxPages:2});
    expect(result.getTicketList).toMatchObject({complete:false,truncated:true,nextPage:3,totalCount:350,recordsReturned:200,truncationReason:"maxPagesReached",continuation:{variables:{input:{page:3,pageSize:100}}}});
  });
  it("fails safely on duplicate pages, deduplicates records, and detects stalls", async () => {
    const page = {getTicketList:{tickets:[{ticketId:"1"}],listInfo:{hasMore:true,totalCount:10}}};
    const spy = vi.fn(async () => page);
    const client = {query:async <T>() => await spy() as T};
    const result = await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
    expect(result.getTicketList).toMatchObject({complete:false,truncated:true,recordsReturned:1,nextPage:2,truncationReason:"repeatedPage"});
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it.each(["maxRecordsReached","responseSizeLimit"])("never drops the rest of a page at %s", async reason => {
    const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(fakePages(),query,{input:{pageSize:100}},reason==="maxRecordsReached"?{maxRecords:150}:{maxBytes:1});
    expect(result.getTicketList).toMatchObject({complete:false,truncated:true,truncationReason:reason});
    expect(result.getTicketList.nextPage).toBe(reason==="maxRecordsReached"?2:1);
  });
  it("does not claim completion when totalCount contradicts hasMore:false", async () => {
    const client={query:async <T>()=>({getTicketList:{tickets:[{ticketId:"1"}],listInfo:{hasMore:false,totalCount:350}}}) as T};
    const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
    expect(result.getTicketList).toMatchObject({complete:false,truncated:true,truncationReason:"totalCountMismatch"});
  });
  it("returns bounded partial results on execution exhaustion", async () => {
    const client=fakePages(); const original=client.query;
    client.query=async <T>(q:string,v?:Record<string,unknown>)=>{recordSubrequestStart(q);return original<T>(q,v);};
    await runWithExecutionConfig({SUPEROPS_EXECUTION_SUBREQUEST_BUDGET:"5",SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN:"3"},()=>runWithExecutionContext("pages",async()=>{
      const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
      expect(result.getTicketList).toMatchObject({complete:false,truncated:true,nextPage:3,recordsReturned:200,truncationReason:"executionBudgetExhausted"});
    }));
  });
  it("rejects invalid pages and all oversized normal query shapes",()=>{
    expect(()=>assertPageBounds("query {getTicketList(input:{pageSize:500}){tickets{ticketId}}}")).toThrow();
    expect(()=>assertPageBounds("query ($size:Int!){getTicketList(input:{pageSize:$size}){tickets{ticketId}}}",{size:500})).toThrow();
    expect(()=>assertPageBounds(query,{input:{page:0,pageSize:100}})).toThrow();
    expect(()=>assertPageBounds("query ($size:Int = 500){getTicketList(input:{pageSize:$size}){tickets{ticketId}}}")).toThrow();
    expect(()=>assertPageBounds("query ($size:Int!){getTicketList(input:{pageSize:$size}){tickets{ticketId}}}")).toThrow();
    expect(()=>assertPageBounds('query {search(text:"pageSize: 500")} # pageSize: 500')).not.toThrow();
    expect(()=>assertPageBounds("query ($size:Int = 100){getTicketList(input:{pageSize:$size}){tickets{ticketId}}}")).not.toThrow();
  });
  it("returns a restartable empty partial if receipt polling exhausts the first-page budget",async()=>{
    const client={query:async <T>():Promise<T>=>{recordSubrequestStart(query);recordSubrequestStart(query);throw new DispatcherPendingError("receipt-1","key","pending");}};
    await runWithExecutionConfig({SUPEROPS_EXECUTION_SUBREQUEST_BUDGET:"5",SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN:"3"},()=>runWithExecutionContext("first-page",async()=>{
      const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
      expect(result.getTicketList).toMatchObject({complete:false,truncated:true,recordsReturned:0,nextPage:1,truncationReason:"executionBudgetExhausted"});
    }));
  });
  it("removes overlapping stable IDs in first-seen order and stops on hasMore false",async()=>{
    const pages=[{tickets:[{ticketId:"a"},{ticketId:"b"}],listInfo:{hasMore:true,totalCount:3}}, {tickets:[{ticketId:"b"},{ticketId:"c"}],listInfo:{hasMore:false,totalCount:3}}];
    const spy=vi.fn(async()=>({getTicketList:pages.shift()}));
    const client={query:async <T>()=>await spy() as T};
    const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
    expect(result.getTicketList).toMatchObject({tickets:[{ticketId:"a"},{ticketId:"b"},{ticketId:"c"}],complete:true,truncated:false,duplicateRecordsRemoved:1,recordsReturned:3,nextPage:null});
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("can prove completion from totalCount but never from a short page alone",async()=>{
    for (const [totalCount,complete] of [[1,true],[undefined,false]] as const) {
      const client={query:async <T>()=>({getTicketList:{tickets:[{ticketId:"1"}],listInfo:{totalCount}}}) as T};
      const result=await fetchAllPages<{getTicketList:Record<string,unknown>}>(client,query,{input:{pageSize:100}});
      expect(result.getTicketList.complete).toBe(complete);
      expect(result.getTicketList.truncated).toBe(!complete);
    }
  });
  it("historical reporting resumes inside a fixed-size page without losing records",async()=>{
    const tickets=Array.from({length:100},(_,i)=>({ticketId:String(i),createdTime:"2026-09-01T12:00:00Z",subject:"synthetic"}));
    const client={query:async <T>()=>({getTicketList:{tickets,listInfo:{page:1,pageSize:100,hasMore:false,totalCount:100}}}) as T};
    const params={createdFrom:"2026-09-01T00:00:00Z",createdTo:"2026-09-02T00:00:00Z",maxRecords:30};
    const first=await fetchTicketsPaginated(client,params);
    expect(first.pagination).toMatchObject({complete:false,truncated:true,nextPage:1,nextPageOffset:30,recordsReturned:30});
    const second=await fetchTicketsPaginated(client,{...params,maxRecords:100,page:1,pageOffset:30});
    expect(second.pagination).toMatchObject({complete:true,truncated:false,recordsReturned:70});
    expect([...first.records,...second.records].map(t=>t.ticketId)).toEqual(tickets.map(t=>t.ticketId));
  });
  it("response-size fallback is explicitly partial and restarts before omitted records",()=>{
    const result=boundedToolResult({content:[{type:"text",text:JSON.stringify({listInfo:{page:3,pageSize:100,totalCount:1000,nextPage:5},records:["x".repeat(4000)]})}]},2000);
    const value=JSON.parse(result.content[0].text);
    expect(value).toMatchObject({complete:false,truncated:true,recordsReturned:0,nextPage:3,totalCount:1000,truncationReason:"responseSizeLimit"});
    expect(value.continuation.page).toBe(3);
  });
});
