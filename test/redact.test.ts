import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/redact.ts";
import { cat, GITHUB_PAT, GITLAB_PAT } from "./fakes.ts";

const secrets: [string, string, string][] = [
  ["github token", `use ${GITHUB_PAT} to push`, "ghp_1234567890"],
  ["github fine-grained", cat("github", "_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV"), "11ABCDEFG0"],
  ["openai", cat("OPENAI_API_KEY=", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"), "sk-proj-abcdef"],
  ["anthropic bare", cat("key is sk-ant", "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef ok"), "AbCdEfGhIjKl"],
  ["slack", cat("xox", "b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"), "1234567890123"],
  ["aws", cat("AKIA", "IOSFODNN7EXAMPLE and aws_secret_", "access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), "wJalrXUtnFEMI"],
  ["google", cat("AIza", "SyA-abcdefghijklmnopqrstuvwxyz0123456"), "abcdefghijklmnop"],
  ["gitlab", GITLAB_PAT, "abcdefghijklmnop"],
  ["bearer", cat("curl -H 'Authorization: Bearer ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'"), "dozjgNryP4J3"],
  ["bare jwt", cat("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), "adQssw5c"],
  ["password=", "db password=hunter2 for staging", "hunter2"],
  ["yaml", "password: correct-horse-battery", "correct-horse"],
  ["query token", "https://api.example.com/v1?token=abc123def&x=1", "abc123def"],
  ["env", "PGPASSWORD=s3cr3t psql -h db", "s3cr3t"],
  ["header", cat("x-api-key: ", "1234567890abcdef"), "1234567890abcdef"],
  ["stripe", cat("sk_", "live_4eC39HqLyjWDarjtT1zdp7dc"), "4eC39HqLyjWD"],
  ["npm", cat("npm", "_abcdefghijklmnopqrstuvwxyz0123456789"), "abcdefghijklmnop"],
  ["private key", cat("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEowIBAAKCAQEAvbqkWnxqU2M8m4K3x9a/Yqk0p8r1kq3vY7H0Z\nab/cd+ef\n-----END RSA PRIVATE KEY-----"), "MIIEow"],
  ["cut-off private key", cat("-----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"), "MIIEvQ"],
  ["json password", '{"password": "hunter2", "user": "bob"}', "hunter2"],
  ["json apiKey", cat('{"apiKey":', '"abcd1234efgh"}'), "abcd1234efgh"],
  ["json api_key", cat('{"api_key": ', '"abcd1234efgh", "n": 1}'), "abcd1234efgh"],
  ["json access_token", cat('{"access_token":', '"ya29.a0AfH6SMBx"}'), "ya29.a0AfH6SMBx"],
  ["json secret and passwd", '{"secret": "s3cr3t-value", "passwd": "pa55w0rd"}', "pa55w0rd"],
  ["cli flag", "mysql --password hunter2 -u root", "hunter2"],
  ["cli flag token", "gh auth login --token ghx_not_a_prefix_secret", "ghx_not_a_prefix_secret"],
  ["url credentials", "postgres://admin:SuperSecretPw1@db.internal:5432/app", "SuperSecretPw1"],
  ["mixed-case base64 run", "key material Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OTw== ends here", "Zm9vYmFyMTIz"],
  ["mixed-case run", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", "a1B2c3D4"],
  ["short value under api_key", "api_key=kq", "kq"],
  ["short value under PGPASSWORD", "PGPASSWORD=zq psql", "zq"],
  ["short value under a header name", "x-api-key: wq", "wq"],
  ["quoted passphrase", 'password="correct horse battery"', "correct horse"],
  ["single-quoted word", "token: 'bucket'", "bucket"],
  ["bare assignment", "password=hunter2", "hunter2"],
  ["mixed-case value", "token: AbCdEfGhIjKl", "AbCdEfGhIjKl"],
  ["long run of letters", "secret=correcthorsebatterystaple", "correcthorse"],
  ["separated passphrase", "secret: purple-monkey-dishwasher", "purple-monkey"],
  ["symbols after a capital", "password=Pa$$word", "Pa$$word"],
  ["at sign after a capital", "password: P@ssword", "P@ssword"],
  ["only symbols", "password=!@#$%^&*", "!@#$%^&*"],
  ["symbols then a full stop", "the password: Tr0ub4dor&3.", "Tr0ub4dor"],
];

const benign: [string, string][] = [
  ["plain task", "refactor the parser and add tests"],
  ["path", "edit /home/dev/projects/agentsocks-v02/src/broker.ts and run npm test"],
  ["cwd one", "session alpha in /home/dev/projects/agentsocks-v02"],
  ["cwd two", "session api in /home/dev/projects/api-gateway"],
  ["cwd three", "session web in /home/dev/work/customer-portal-frontend/packages/ui"],
  ["cwd four", "session x in /srv/app"],
  ["source path", "Fix the failing test in src/broker.ts and rerun"],
  ["test path", "Investigate why test/delivery.test.ts fails on CI shard 3"],
  ["long path", "/home/dev/projects/some-really-long-directory-name-for-testing/another-long-directory-name/file.ts"],
  ["uuid", "thread 019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b is stuck"],
  ["short sha", "revert commit 9fceb02 on main"],
  ["full sha", "cherry-pick 9fceb02d0ae598e95dc970b74767f19372d61af8"],
  ["key id", "commit-signing key 3AA5C34371567BD2 on file"],
  ["url", "see https://example.com/docs/getting-started?ref=nav#install"],
  ["url with port and path", "curl http://localhost:8080/health/check@v2"],
  ["camel case", "rename getUserAuthenticationTokenFromRequestHeaderValue to readToken"],
  ["snake case", "the function load_environment_configuration_from_filesystem_defaults is slow"],
  ["upper case run", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA padding bytes"],
  ["lower and digits run", "build 20261008abcdef0123456789abcdef0123456789 finished"],
  ["flag followed by a flag", "run --token --verbose now"],
  ["flag name containing a key word", "run --token-budget 5000"],
  ["key as a database term", "primary key: id"],
  ["token as a plain word", "token: bucket"],
  ["secret as a plain word", "secret: santa"],
  ["password as a plain word", "password: required"],
  ["capitalised word", "token: Bucket and secret: Santa"],
  ["sentence", "the api key: see the vault page, and the secret: none yet"],
  ["identifier value", "primary key: user_id and token: bucket-name"],
  ["plain word then punctuation", "token: bucket. password: required, secret: santa!"],
  ["path value", "key: src/broker.ts"],
];

test("secrets are redacted: token prefixes, assignments, JSON fields, CLI flags, URL credentials and mixed-case long runs", () => {
  for (const [name, input, fragment] of secrets) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(fragment), `${name} leaked: ${out}`);
    assert.ok(out.includes("[redacted]"), `${name} not marked: ${out}`);
  }
});

test("the redacted forms keep everything around the secret", () => {
  assert.equal(redactSecrets("postgres://admin:SuperSecretPw1@db.internal:5432/app"), "postgres://admin:[redacted]@db.internal:5432/app");
  assert.equal(redactSecrets("https://user:p@ss@example.com/x"), "https://user:[redacted]@example.com/x");
  assert.equal(redactSecrets("mysql --password hunter2 -u root"), "mysql --password [redacted] -u root");
  assert.equal(redactSecrets("mysql --password=hunter2 -u root"), "mysql --password=[redacted] -u root");
  assert.ok(redactSecrets('{"password": "hunter2", "user": "bob"}').endsWith(', "user": "bob"}'));
  assert.equal(redactSecrets(`use ${GITHUB_PAT} to push`), "use [redacted] to push");
});

test("paths, uuids, hashes and identifiers are long but not secrets, so they survive", () => {
  for (const [name, input] of benign) assert.equal(redactSecrets(input), input, name);
});

const LOWER_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const shaped = (prefix: string, length: number, alphabet = LOWER_DIGITS, step = 7): string =>
  prefix + Array.from({ length }, (_, i) => alphabet[(i * step + 3 * (i % 5) + length) % alphabet.length]).join("");
const typeSafeShaped = shaped("abcdef_", 100);
const digitalOceanShaped = shaped("dop_v1_", 64, "0123456789abcdef", 5);

function survivors(secret: string, output: string): string[] {
  const windows: string[] = [];
  for (let at = 0; at + 12 <= secret.length; at += 6) windows.push(secret.slice(at, at + 12));
  return windows.filter((w) => output.includes(w));
}

test("a prefixed lowercase API key of TypeSafe's shape is redacted bare, quoted, after --key and inside a classifier command", () => {
  for (const key of [typeSafeShaped, digitalOceanShaped]) {
    const forms = [
      `use ${key} now`,
      `"${key}"`,
      `'${key}'`,
      `key: ${key}.`,
      `agentsocks classifier jev --key ${key}`,
      `agentsocks classifier jev --key=${key}`,
      `TYPESAFE_API_KEY=${key} agentsocks doctor`,
      `export TOKEN_X="${key}"`,
    ];
    for (const form of forms) {
      const out = redactSecrets(form);
      assert.deepEqual(survivors(key, out), [], `${form.replace(key, "<KEY>")} leaked: ${out.slice(0, 80)}`);
      assert.ok(out.includes("[redacted]"), form.replace(key, "<KEY>"));
    }
  }
});

test("the bare --key flag hides its value, and keeps the stdin form and a following flag", () => {
  assert.equal(redactSecrets("tool --key hunter2 --verbose"), "tool --key [redacted] --verbose");
  assert.equal(redactSecrets("tool --key 'two words' next"), "tool --key [redacted] next");
  assert.equal(redactSecrets("agentsocks classifier jev --key -"), "agentsocks classifier jev --key -");
  assert.equal(redactSecrets("agentsocks classifier jev --key --key-file x"), "agentsocks classifier jev --key --key-file x");
  assert.equal(redactSecrets("run --keyboard qwerty --monkey banana"), "run --keyboard qwerty --monkey banana");
});

test("every value of an env-style KEY, TOKEN, SECRET or PASSWORD assignment is redacted, whatever it looks like", () => {
  for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "STRIPE_SECRET", "DB_PASSWORD", "MY_APP_KEY", "export SLACK_TOKEN"]) {
    for (const value of ["x1", "kq", "plainword", "Capital", "hunter2", "a-b", '"two words"', "'it works'"]) {
      const out = redactSecrets(`${name}=${value} and more text`);
      assert.ok(out.startsWith(`${name}=[redacted]`), `${name}=${value} -> ${out}`);
    }
  }
});

test("SHAs, uuids, paths and snake_case names are not mistaken for prefixed keys", () => {
  const benignRuns = [
    "9fceb02d0ae598e95dc970b74767f19372d61af8",
    "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
    "/home/dev/work/some_directory_with_digits_12345_and_more/another_dir_name_67890_final/file_name_v2_final_copy.ts",
    "load_environment_configuration_from_filesystem_defaults",
    "md5_sha1_sha256_checksum_calculation_helper",
    "build_20261008_release_candidate_notes_final",
    "test_for_issue_1234_in_parser_module_again",
    "kubernetes_pod_restart_count_alert_threshold",
    "src/some_long_snake_case_module_name_v1_v2_v3/index.ts",
  ];
  for (const run of benignRuns) {
    assert.equal(redactSecrets(`see ${run} for details`), `see ${run} for details`, run);
    assert.equal(redactSecrets(`edit ${run}.`), `edit ${run}.`, run);
  }
});

test("redaction is linear, and 4000 characters of adversarial input take under 10 ms", () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
  const exact = (head: string) => head.padEnd(4000, "x");
  const shapes: Record<string, string> = {
    dashes: fill("--"),
    chain: fill("a-"),
    dots: fill("a."),
    schemeChars: fill("a+"),
    underscores: fill("a_"),
    keys: fill("key "),
    keyThenSpaces: `key${" ".repeat(3997)}`,
    quotedPassword: fill('"password" '),
    passwordEquals: fill("password = "),
    tokenFlags: fill("--token "),
    keyFlags: fill("--key "),
    urls: fill("a://b:"),
    jwtDash: fill("eyJ-"),
    jwtDot: fill("eyJ."),
    bearer: fill("Bearer "),
    prefixedKey: `ab_${"a1".repeat(1998)}a`,
    pem: fill("-----BEGIN "),
    jsonKeys: fill('"key": "'),
    quotes: fill('"'),
    punctuationTail: `password=${".".repeat(3990)}x`,
    mixedRuns: fill(`Ab1${"x".repeat(30)}-`),
    jwtDashes: fill("eyJabcde-"),
    jwtDashesThenDot: exact(`${"eyJabcde-".repeat(443)}.x`),
    jwtDashesThenTwoShortParts: exact(`${"eyJabcde-".repeat(440)}.ab.cd`),
    jwtDots: fill("eyJabcde."),
    jwtShortDots: fill("eyJab."),
    jwtOneLongPart: exact(`${"a".repeat(1990)}.${"b".repeat(1000)}.${"c".repeat(990)}`),
    jwtHyphenatedChain: fill("a-eyJabcde.eyJabcde.sig12-"),
  };
  for (const [name, input] of Object.entries(shapes)) {
    assert.equal(input.length, 4000, name);
    redactSecrets(input);
    const times = [0, 1, 2].map(() => {
      const started = process.hrtime.bigint();
      redactSecrets(input);
      return Number(process.hrtime.bigint() - started) / 1e6;
    });
    assert.ok(Math.min(...times) < 10, `${name} took ${Math.min(...times).toFixed(1)} ms`);
  }
});

test("input beyond 4000 characters is cut before any matching", () => {
  const out = redactSecrets(`${"x ".repeat(2000)}${GITHUB_PAT}`);
  assert.equal(out.length, 4000);
  assert.ok(!out.includes("ghp_"));
});

const OLD_JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const JWT = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM";

test("a JWT is redacted wherever a word boundary puts it, which includes after a hyphen", () => {
  const inputs = [
    JWT,
    `token-${JWT}`,
    `x-api-token-${JWT} next`,
    `--${JWT}`,
    `a-${JWT}`,
    `a.${JWT}`,
    `a.b.${JWT}.`,
    `${JWT}.extra`,
    `${JWT}.`,
    `(${JWT})`,
    `auth ${JWT} and ${JWT}`,
    `${JWT}.${JWT}`,
    `..${JWT}`,
    `\u00e9${JWT}`,
    "eyJhb-Gc_iOi.eyJzd-WIiOi.Sfl_Kxw-RJSM",
    "token-eyJhb-Gc_iOi.eyJzd-WIiOi.Sfl_Kxw-RJSM",
    `x${JWT}`,
    `x_${JWT}`,
    `1${JWT}`,
    "eyJhbGciOi.eyJzdWIiOi",
    "eyJab.eyJzdWIiOi.SflKxwRJSM",
    "eyJhbGciOi.eyJz.SflKxwRJSM",
    "eyJhbGciOi.eyJzdWIiOi.Sfl",
    "token-eyJab.eyJzdWIiOi.SflKxwRJSM",
    "token-eyJhbGciOi.eyJz.SflKxwRJSM",
  ];
  for (const input of inputs) assert.equal(redactSecrets(input), input.replace(OLD_JWT, "[redacted]"), input);
  assert.equal(redactSecrets(`token-${JWT}`), "token-[redacted]");
  assert.equal(redactSecrets(`x${JWT}`), `x${JWT}`);
});
