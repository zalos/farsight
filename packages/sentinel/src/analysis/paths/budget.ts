// Fixed worker-wide accounting. These are decoded input/cache and traversal ceilings, not a hard heap/RSS limit.
// Every query shares one budget and absolute deadline; exhaustion refuses the whole output, never a partial result.
export const PATH_EXECUTION_LIMITS = Object.freeze({ reads: 1024, decodedBytes: 64 * 1024 * 1024,
  cacheBytes: 64 * 1024 * 1024, visited: 1_000_000, steps: 4_000_000, outputBytes: 4 * 1024 * 1024 });
export type PathExecutionLimits = Readonly<Record<keyof typeof PATH_EXECUTION_LIMITS, number>>;
export class PathBudgetError extends Error {
  readonly code = 'sentinel.paths.budgetExceeded';
  constructor(readonly reason: keyof PathExecutionLimits | 'deadline' | 'canceled' | 'invalid-limits') {
    super('sentinel.paths.budgetExceeded');this.name='PathBudgetError';
  }
}
export class PathExecutionBudget {
  readonly #limits: PathExecutionLimits;
  readonly #signal?: AbortSignal;
  readonly #deadlineAt: number;
  readonly #started = performance.now();
  readonly #spent = { reads: 0, decodedBytes: 0, cacheBytes: 0, visited: 0, steps: 0, outputBytes: 0 };
  constructor(options: { signal?: AbortSignal; deadlineAt?: number; limits?: PathExecutionLimits } = {}) {
    const input=options.limits===undefined?PATH_EXECUTION_LIMITS:options.limits;
    if(!input||typeof input!=='object'||Array.isArray(input))throw new PathBudgetError('invalid-limits');
    this.#limits=Object.freeze(Object.fromEntries(Object.entries(PATH_EXECUTION_LIMITS).map(([name,ceiling])=>{
      const value=input[name as keyof PathExecutionLimits];
      if(!Number.isSafeInteger(value)||value<0||value>ceiling)throw new PathBudgetError('invalid-limits');
      return [name,value];
    }))) as PathExecutionLimits;
    const providedDeadline=options.deadlineAt;
    const supplied=providedDeadline===undefined?Infinity:providedDeadline;
    if(typeof supplied!=='number'||Number.isNaN(supplied)||supplied<0)throw new PathBudgetError('invalid-limits');
    this.#deadlineAt=Math.min(this.#started+120_000,supplied);this.#signal=options.signal;
    this.boundary();
  }
  boundary(): void {
    if(this.#signal?.aborted)throw new PathBudgetError('canceled');
    if(performance.now()>=this.#deadlineAt)throw new PathBudgetError('deadline');
  }
  #add(name:keyof PathExecutionLimits, amount:number):void {
    this.boundary();
    if(!Number.isSafeInteger(amount)||amount<0||this.#spent[name]+amount>this.#limits[name])throw new PathBudgetError(name);
    this.#spent[name]+=amount;
  }
  read():void {this.#add('reads',1)}
  bytes(bytes:number):void {this.#add('decodedBytes',bytes);this.#add('cacheBytes',bytes)}
  visit():void {this.#add('visited',1)}
  step():void {this.#add('steps',1)}
  result(value:unknown):void {this.#add('outputBytes',Buffer.byteLength(JSON.stringify(value)))}
  output(bytes:number):void {this.boundary();if(bytes>this.#limits.outputBytes)throw new PathBudgetError('outputBytes')}
  usage(){const {outputBytes,...spent}=this.#spent;return {...spent,resultBytes:outputBytes,elapsedMs:performance.now()-this.#started}}
}
