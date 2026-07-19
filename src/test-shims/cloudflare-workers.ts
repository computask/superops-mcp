export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected ctx: unknown;
  protected env: Env;
  protected props: Props | undefined;

  constructor(ctx?: unknown, env?: Env, props?: Props) {
    this.ctx = ctx;
    this.env = env as Env;
    this.props = props;
  }
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
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env: Env;
  constructor(_ctx?: unknown, env?: Env) { this.env = env as Env; }
  async run(_event: WorkflowEvent<Params>, _step: WorkflowStep): Promise<unknown> { return undefined; }
}
