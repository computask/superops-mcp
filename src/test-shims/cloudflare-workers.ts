export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected ctx: unknown;
  protected env: Env | undefined;
  protected props: Props | undefined;

  constructor(ctx?: unknown, env?: Env, props?: Props) {
    this.ctx = ctx;
    this.env = env;
    this.props = props;
  }
}
