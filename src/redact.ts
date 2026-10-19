const MARK = "[redacted]";

// every pattern below either has a bounded run or is anchored where a run starts, so no input makes the engine rescan a run from each of its characters
const TOKEN_PREFIXES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

// a JWT may follow a hyphen ("token-eyJ..."), and a start after every hyphen would rescan the rest of a hyphen chain each time, so this works on whole dotted words: one regex pass finds them, and the parts are walked once
const DOTTED_WORD = /(?<![\w-])[\w-]+(?:\.[\w-]+){2,}/g;
const JWT_HEAD = /(?:^|-)eyJ/;
const JWT_HEAD_MIN = 8;
const JWT_PART_MIN = 5;

function redactJwts(text: string): string {
  return text.replace(DOTTED_WORD, (word) => {
    const parts = word.split(".");
    const out: string[] = [];
    for (let i = 0; i < parts.length; ) {
      const part = parts[i]!;
      const head = JWT_HEAD.exec(part);
      const at = head ? head.index + head[0].length - 3 : -1;
      const isJwt = at >= 0 && part.length - at >= JWT_HEAD_MIN && (parts[i + 1]?.length ?? 0) >= JWT_PART_MIN && (parts[i + 2]?.length ?? 0) >= JWT_PART_MIN;
      out.push(isJwt ? `${part.slice(0, at)}${MARK}` : part);
      i += isJwt ? 3 : 1;
    }
    return out.join(".");
  });
}

// a vendor prefix, an underscore and a long lowercase tail (TypeSafe, DigitalOcean); the shape alone also fits snake_case names, so the tail must also switch between letters and digits
const PREFIXED_KEY = /(?<![\w/.-])[a-z][a-z0-9]{1,15}_[a-z0-9_]{24,}(?![\w-]|\.\w|\/)/g;
const SWITCHES = /(?=[a-z]\d|\d[a-z])/g;
const MIN_SWITCHES = 4;

const URL_PASSWORD = /((?<![\w+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s/]+@/gi;
const ASSIGNMENT = /(?<![\w-])("?)([\w-]*(?:key|token|password|passwd|secret))("?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const FLAG = /(?<![\w-])(--(?:key|[\w-]*(?:password|passwd|token|secret|api-?key))\s+)(?!-)(?:"[^"]*"|'[^']*'|\S+)/gi;
const MAX_INPUT = 4000;
// paths, uuids, hashes and identifiers are long and harmless; a key mixes cases and digits
const LONG_RUN = /[A-Za-z0-9+=]{32,}/g;

const looksLikeKey = (run: string): boolean => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
const keyShaped = (run: string): boolean => (run.match(SWITCHES)?.length ?? 0) >= MIN_SWITCHES;

const BARE_NAME = /^(?:key|token|password|passwd|secret)$/i;
const TAIL_PUNCTUATION = ".,;:!?)]}";

function withoutTailPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TAIL_PUNCTUATION.includes(value[end - 1]!)) end--;
  return value.slice(0, end);
}

// a bare "key", "token", "secret" or "password" is often prose ("primary key: id"); an identifier like api_key is not, so it is always redacted
function looksLikeSecretValue(value: string): boolean {
  if (/^["']/.test(value)) return true;
  const core = withoutTailPunctuation(value);
  if (/\d/.test(core)) return core.length >= 4;
  if (/[^\w.\-/]/.test(core)) return core.length >= 6;
  if (/[a-z]/.test(core) && /[A-Z]/.test(core.slice(1))) return core.length >= 8;
  return /^[A-Za-z]{16,}$/.test(core) || (core.length >= 12 && /[-_]/.test(core));
}

export function redactSecrets(text: string): string {
  let out = text.slice(0, MAX_INPUT);
  for (const pattern of TOKEN_PREFIXES) out = out.replace(pattern, MARK);
  out = redactJwts(out);
  out = out.replace(PREFIXED_KEY, (run) => (keyShaped(run) ? MARK : run));
  out = out.replace(URL_PASSWORD, `$1${MARK}@`);
  out = out.replace(ASSIGNMENT, (match, quote: string, name: string, middle: string, value: string) =>
    BARE_NAME.test(name) && !looksLikeSecretValue(value) ? match : `${quote}${name}${middle}${MARK}`,
  );
  out = out.replace(FLAG, (_, lead: string) => `${lead}${MARK}`);
  return out.replace(LONG_RUN, (run) => (looksLikeKey(run) ? MARK : run));
}
