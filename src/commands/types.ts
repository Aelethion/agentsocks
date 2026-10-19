export const STAY_RUNNING = -1;

export type Handler = (args: string[], invoked: string) => Promise<number>;

export interface Usage {
  synopsis: string;
  summary: string;
}

export interface Command {
  name: string;
  aliases?: readonly string[];
  usage: readonly Usage[];
  load: () => Promise<Handler>;
}
