export function parseEnvironRoots(environ: string[]): {
  runtime: string | undefined;
  tmp: string | undefined;
  testFile: string | undefined;
}
