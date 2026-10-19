const KEEP = /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|TERM|TZ|CLAUDE_CONFIG_DIR|CODEX_HOME|TS_SOCKET|XDG_[A-Z_]+|NODE_[A-Z_]+|LC_[A-Z_]+|AGENTSOCKS_[A-Z_]+)$/;

export function hookEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && KEEP.test(e[0])));
}
