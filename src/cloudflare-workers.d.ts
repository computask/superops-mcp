declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: unknown;
    protected env: Env | undefined;
    protected props: Props | undefined;

    constructor(ctx?: unknown, env?: Env, props?: Props);
  }
}
