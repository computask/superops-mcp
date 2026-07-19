declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: unknown;
    protected env: Env;
    protected props: Props | undefined;
    constructor(ctx?: unknown, env?: Env, props?: Props);
  }

  export type WorkflowEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
  };

  export interface WorkflowStep {
    sleepUntil(name: string, timestamp: Date | number): Promise<void>;
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: {
      retries?: { limit: number; delay: string; backoff: "constant" | "linear" | "exponential" };
      timeout?: string;
    }, callback: () => Promise<T>): Promise<T>;
  }

  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    constructor(ctx?: unknown, env?: Env);
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
