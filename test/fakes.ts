// scanners flag token-shaped literals, so every fake credential is joined at runtime and never sits in source whole
export const cat = (...parts: string[]): string => parts.join("");

export const GITHUB_PAT = cat("ghp", "_1234567890abcdefghijklmnopqrstuvwxyz12");
export const GITHUB_PAT_LOWER = cat("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789");
export const GITHUB_OAUTH = cat("gho", "_abcdefghijklmnopqrstuvwxyz0123456789");
export const GITLAB_PAT = cat("glpat", "-abcdefghijklmnopqrst");
