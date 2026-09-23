import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Exercise the real workerd Request/fetch implementation, not Node's fetch.
// Both dependencies are supplied by the pinned Wrangler development toolchain.
describe("dispatcher in workerd", () => {
  it("submits and rejects redirects safely in the production runtime", async () => {
    const bundle = await build({
      stdin: {contents: `import {dispatcherFetch} from './src/dispatcher.ts';
        export default {async fetch(request) {
          try {
            const response = await dispatcherFetch('{}', {env:{DISPATCHER_TOKEN:'synthetic'}, idempotencyKey:'runtime-test'});
            return Response.json({status:response.status, result:await response.json()});
          } catch(error) {return Response.json({state:error.state, message:error.message})}
        }};`, resolveDir: process.cwd(), loader:"ts"},
      bundle:true, write:false, format:"esm", platform:"neutral", external:["node:*", "cloudflare:workers"],
    });
    let redirect = false;
    const calls: string[] = [];
    const mf = new Miniflare({
      modules:true, script:bundle.outputFiles[0].text,
      compatibilityDate:"2026-07-01", compatibilityFlags:["nodejs_compat"],
      outboundService: async (request: {url: string}) => {
        calls.push(request.url);
        return redirect ? new Response(null, {status:302, headers:{Location:"https://untrusted.example/"}})
          : Response.json({data:{ok:true}});
      },
    });
    try {
      expect(await (await mf.dispatchFetch("http://localhost")).json()).toEqual({status:200,result:{data:{ok:true}}});
      redirect = true;
      expect(await (await mf.dispatchFetch("http://localhost")).json()).toMatchObject({state:"redirect_rejected"});
      expect(calls).toEqual(Array(2).fill("https://superops-api-dispatcher.taskgroup.co.uk/graphql"));
    } finally { await mf.dispose(); }
  }, 30000);
});
