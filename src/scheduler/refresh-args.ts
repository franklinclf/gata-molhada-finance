export interface RefreshArgs {
  force: boolean;
}

export function parseRefreshArgs(argv: string[]): RefreshArgs {
  const args: RefreshArgs = { force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}
