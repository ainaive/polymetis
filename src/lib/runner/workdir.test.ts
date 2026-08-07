import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCloneArgs,
  classifyRepoSource,
  cloneEnv,
  cloneInto,
  prepareWorkdir,
} from "./workdir";

/** A local git repository with two commits, for driving a real clone. */
function makeOrigin(prefix: string): string {
  const origin = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync("git", [
      "-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", ...args,
    ]);
  execFileSync("git", ["init", "-q", "--initial-branch=main", origin]);
  writeFileSync(join(origin, "README.md"), "# first\n");
  git("add", ".");
  git("commit", "-qm", "first");
  writeFileSync(join(origin, "README.md"), "# second\n");
  git("add", ".");
  git("commit", "-qm", "second");
  return origin;
}

describe("classifyRepoSource", () => {
  test("treats an https URL as something to clone", () => {
    expect(classifyRepoSource("https://github.com/o/r.git")).toEqual({
      kind: "clone",
      url: "https://github.com/o/r.git",
    });
  });

  test("treats an absolute path as a checkout that already exists", () => {
    expect(classifyRepoSource("/home/dev/proj")).toEqual({
      kind: "local",
      path: "/home/dev/proj",
    });
  });

  test("refuses transports that would use the host's own credentials", () => {
    // ssh:// would authenticate with the operator's keys, and git:// is
    // unauthenticated but also unverified.
    expect(() => classifyRepoSource("ssh://git@github.com/o/r.git")).toThrow(/https/);
    expect(() => classifyRepoSource("git://github.com/o/r.git")).toThrow(/https/);
  });

  test("refuses file://, which would escape what the bind mount contains", () => {
    expect(() => classifyRepoSource("file:///etc")).toThrow(/https/);
  });

  test("refuses a URL with credentials in it", () => {
    // git writes the remote into the clone's config, and the clone is
    // bind-mounted into the sandbox — ADR-0002 forbids exactly that.
    expect(() => classifyRepoSource("https://user:tok@github.com/o/r.git")).toThrow(
      /credential/,
    );
  });

  test("refuses an empty repo", () => {
    expect(() => classifyRepoSource("   ")).toThrow(/empty/);
  });
});

describe("buildCloneArgs", () => {
  const args = buildCloneArgs("https://github.com/o/r.git", "/w/repo");

  test("disables repository-supplied hooks", () => {
    // A cloned repo is untrusted input; hooks run as the worker.
    expect(args.join(" ")).toContain("core.hooksPath=/dev/null");
  });

  test("forbids the ext transport, which executes a command from config", () => {
    expect(args.join(" ")).toContain("protocol.ext.allow=never");
  });

  test("does not create symlinks from repository content", () => {
    // A symlink in the checkout is a link the sandbox follows out of the mount.
    expect(args.join(" ")).toContain("core.symlinks=false");
  });

  test("clones shallow and single-branch", () => {
    expect(args).toContain("--depth");
    expect(args).toContain("--no-tags");
    expect(args).toContain("--single-branch");
  });

  test("ends the options with -- so a URL cannot be read as a flag", () => {
    const i = args.indexOf("--");
    expect(i).toBeGreaterThan(-1);
    expect(args.slice(i + 1)).toEqual(["https://github.com/o/r.git", "/w/repo"]);
  });
});

describe("cloneEnv", () => {
  test("carries no credential the host may have configured", () => {
    const env = cloneEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_secret",
      HOME: "/Users/dev",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    expect(env.GITHUB_TOKEN).toBeUndefined();
    // HOME is what git reads ~/.gitconfig from, where credential.helper lives.
    expect(env.HOME).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("neutralises git's own config and prompt escapes", () => {
    const env = cloneEnv({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    // Without this a private repo hangs a worker on a password prompt.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("prepareWorkdir", () => {
  test("uses a local checkout in place and never deletes it", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "polymetis-checkout-"));
    writeFileSync(join(checkout, "README.md"), "# real work\n");

    const prepared = await prepareWorkdir({ runId: "run_local", repo: checkout });
    expect(prepared.path).toBe(checkout);

    prepared.release();
    // release() on a developer's own checkout must be a no-op. Deleting it
    // would destroy uncommitted work to clean up after a run.
    expect(existsSync(join(checkout, "README.md"))).toBe(true);
  });

  test("rejects a local path that is not a directory", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "polymetis-f-")), "not-a-dir");
    writeFileSync(file, "x");
    await expect(prepareWorkdir({ runId: "run_x", repo: file })).rejects.toThrow(
      /not a directory/,
    );
  });

  test("a real clone fetches the content and only the last commit", () => {
    // Runs git for real, against a local origin so the test needs no network.
    // The URL is file:// rather than a bare path because git ignores --depth on
    // a path clone — with a bare path this assertion would pass whether or not
    // the flag were there, which is no assertion at all.
    const origin = makeOrigin("polymetis-origin-");

    const target = join(mkdtempSync(join(tmpdir(), "polymetis-clone-")), "repo");
    execFileSync("git", buildCloneArgs(`file://${origin}`, target), { env: cloneEnv() as NodeJS.ProcessEnv });

    expect(existsSync(join(target, "README.md"))).toBe(true);
    // Two commits upstream, one here: --depth 1 took effect.
    expect(
      execFileSync("git", ["-C", target, "rev-list", "--count", "HEAD"]).toString().trim(),
    ).toBe("1");
    expect(
      execFileSync("git", ["-C", origin, "rev-list", "--count", "HEAD"]).toString().trim(),
    ).toBe("2");
  });

  test("a clone is usable by the sandbox uid", async () => {
    // The container runs as 65532, not the uid that cloned; a bind mount
    // preserves host ownership, so the workdir must grant world access — the
    // isolation verification failed on real Linux without this.
    const origin = makeOrigin("polymetis-origin3-");
    const root = mkdtempSync(join(tmpdir(), "polymetis-root3-"));

    const prepared = await cloneInto(`file://${origin}`, { runId: "run_m", root });

    // The mountpoint: traverse, read and write for everyone (a+rwX).
    expect(statSync(prepared.path).mode & 0o007).toBe(0o007);
    // Content: readable; X adds execute to directories, not plain files.
    expect(statSync(join(prepared.path, "README.md")).mode & 0o006).toBe(0o006);

    prepared.release();
  });

  test("release removes the clone", async () => {
    // cloneInto is the mechanism without the URL policy, so it can be driven
    // from a local origin. classifyRepoSource still refuses file:// for real
    // callers — that guard is asserted above.
    const origin = makeOrigin("polymetis-origin2-");
    const root = mkdtempSync(join(tmpdir(), "polymetis-root-"));

    const prepared = await cloneInto(`file://${origin}`, { runId: "run_c", root });
    expect(existsSync(join(prepared.path, "README.md"))).toBe(true);

    prepared.release();
    expect(existsSync(prepared.path)).toBe(false);
  });

  test("a failed clone leaves nothing behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "polymetis-root2-"));

    await expect(
      cloneInto(`file://${join(tmpdir(), "polymetis-does-not-exist")}`, {
        runId: "run_missing",
        root,
      }),
    ).rejects.toThrow(/git clone failed/);

    // The per-run directory was created before the clone ran; a failure must
    // not leave a husk of it in tmp for someone to wonder about later.
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("hosts a run may not reach", () => {
  const rejected = [
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://localhost:8080/git/repo.git",
    "https://127.0.0.1/repo.git",
    "https://10.0.0.5/git/repo.git",
    "https://192.168.1.10/repo.git",
    "https://172.16.0.9/repo.git",
    "https://[::1]/repo.git",
    "https://[fe80::1]/repo.git",
    // IPv4-mapped IPv6 names the same endpoint as the embedded v4 address;
    // the URL parser renders it in hex before the guard sees it.
    "https://[::ffff:127.0.0.1]/repo.git",
    "https://[::ffff:169.254.169.254]/repo.git",
    // A trailing dot is the same name to the resolver.
    "https://localhost./repo.git",
    "https://metadata.google.internal./computeMetadata/v1/",
  ];

  for (const url of rejected) {
    test(`refuses ${url}`, () => {
      // The worker runs inside the trust boundary. Cloning one of these is
      // server-side request forgery driven by a run input.
      expect(() => classifyRepoSource(url)).toThrow(/not reachable/);
    });
  }

  test("still accepts an ordinary public host", () => {
    expect(classifyRepoSource("https://github.com/o/r.git").kind).toBe("clone");
  });

  test("does not reject a public address that merely looks similar", () => {
    // 172.32 is outside 172.16/12, and 169.253 is not link-local.
    expect(classifyRepoSource("https://172.32.0.1/r.git").kind).toBe("clone");
    expect(classifyRepoSource("https://169.253.0.1/r.git").kind).toBe("clone");
    // A mapped *public* address is judged as that address, not refused outright.
    expect(classifyRepoSource("https://[::ffff:140.82.112.3]/r.git").kind).toBe(
      "clone",
    );
  });
});

describe("a token for a private repository", () => {
  const TOKEN = "ghs_installationtokenvalue";

  test("travels in the environment, not in argv", () => {
    // argv is readable through `ps` by every user on the host — the same reason
    // the container's environment goes through a file rather than -e.
    const args = buildCloneArgs("https://github.com/o/private.git", "/w/repo");
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.join(" ")).not.toContain("extraheader");
  });

  test("is sent as an Authorization header through git config", () => {
    const env = cloneEnv({ PATH: "/usr/bin" }, TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraheader");

    const value = env.GIT_CONFIG_VALUE_0!;
    expect(value.startsWith("Authorization: Basic ")).toBe(true);
    expect(
      Buffer.from(value.replace("Authorization: Basic ", ""), "base64").toString(),
    ).toBe(`x-access-token:${TOKEN}`);
  });

  test("does not follow redirects while carrying the header", () => {
    // git follows the initial redirect by default, and the header would go
    // wherever it lands — overruling the github.com-only check that decides
    // where this credential may be sent at all.
    const env = cloneEnv({ PATH: "/usr/bin" }, TOKEN);
    expect(env.GIT_CONFIG_KEY_1).toBe("http.followRedirects");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
  });

  test("adds nothing when there is no token", () => {
    const env = cloneEnv({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  test("a real clone leaves no credential in the checkout", async () => {
    // The property ADR-0004 claims, checked rather than asserted: .git/config
    // is inside the bind mount, so a token written there would be handed to the
    // agent along with the code.
    const origin = makeOrigin("polymetis-private-");
    const root = mkdtempSync(join(tmpdir(), "polymetis-tokenroot-"));

    const prepared = await cloneInto(`file://${origin}`, {
      runId: "run_tok",
      root,
      token: TOKEN,
    });

    const config = readFileSync(join(prepared.path, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain("extraheader");
    // The remote is the plain URL, with no credential spliced into it.
    expect(config).toContain(`file://${origin}`);

    // Nothing anywhere else in .git either. Walked in JS rather than shelled
    // out to grep, which exits non-zero on "found nothing" — the very outcome
    // being asserted.
    expect(filesContaining(join(prepared.path, ".git"), TOKEN)).toEqual([]);
  });
});

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...filesContaining(path, needle));
    } else if (entry.isFile() && readFileSync(path).includes(needle)) {
      hits.push(path);
    }
  }
  return hits;
}

describe("redacting a clone failure", () => {
  test("removes the encoded credential git actually sees", async () => {
    // git never sees the raw token: it is sent as
    // Authorization: Basic base64("x-access-token:" + token). A failure that
    // echoes the header therefore carries the encoded form, which is
    // reversible — and this message is stored on the run row and shown in the
    // UI. Redacting only the raw token left the credential in plain sight.
    const token = "ghs_secrettokenvalue";
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    const root = mkdtempSync(join(tmpdir(), "polymetis-redact-"));

    // A clone that fails, so the error path runs for real.
    const error = await cloneInto(`file://${join(tmpdir(), "polymetis-absent")}`, {
      runId: "run_redact",
      root,
      token,
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(token);
    expect(message).not.toContain(encoded);
  });
});
