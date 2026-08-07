# ADR-0004: Repository access uses short-lived installation tokens

Status: accepted (2026-08-07). Extends ADR-0002.

## Context

ADR-0002 deferred repository access to "a separate consented step in M3,
preferring a GitHub App with fine-grained `contents: read` over classic
scopes". M3b implements it, and that raises a question ADR-0002 did not answer:
a clone needs a credential, and the clone's output is bind-mounted into a
sandbox running untrusted repository content.

ADR-0002 point 3 says no credential crosses into the container. `git clone`
makes that harder than it sounds, because git persists what it was given:
`remote.origin.url` is written into `.git/config`, and `.git` is inside the
mount. The obvious approach — and the one nearly every example shows —

```
git clone https://x-access-token:${TOKEN}@github.com/owner/repo.git
```

writes the token to disk inside the directory we then hand to the agent.

## Decision

1. **A GitHub App, not OAuth scopes.** GitHub's classic `repo` scope grants
   *write* to every private repository the user can reach, which contradicts v1
   being read-only. The App requests `contents: read` and `metadata: read` on
   the repositories a person selects.

2. **No repository token is stored.** `githubInstallations` holds an
   installation id, which is useless without the App's private key. A token is
   minted when a clone or an issue fetch needs one, lives about an hour, and is
   never written to the database. Storing one would recreate exactly the
   long-lived credential the App was chosen to avoid.

3. **The token reaches git through the environment, as a header.**
   `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` set
   `http.extraheader` for the duration of the process, without persisting it:

   - **Not in the URL**, because git writes the remote into `.git/config`,
     which is bind-mounted.
   - **Not on the command line**, because argv is readable through `ps` by
     every user on the host — the same reason the container's environment goes
     through a file rather than repeated `-e` flags (ADR-0003).

4. **Only `github.com`.** The header is attached based on the repository URL's
   host. Sending a GitHub credential to any other host because a run input said
   so is the kind of mistake that is obvious only afterwards.

5. **An installation is claimed only by someone who can administer it.** The
   callback receives `installation_id` as an ordinary query parameter, so it
   proves three things before writing: a signed `state` this server issued to
   the session, the installation appearing in that user's own
   `/user/installations`, and that no other workspace already holds it.

   Minting an installation token is **not** such a proof. It succeeds for every
   installation of the App, including other customers'. The first version of
   this code used it as one — and said so in a comment — which would have let
   anyone attach someone else's installation to their own workspace.

6. **Failing to mint a token is not fatal.** A public repository clones without
   one. Treating it as fatal would turn "someone uninstalled the App" into
   every run in that workspace failing.

## Consequences

The credential surface for repository access is: the App's private key in the
server's environment, and an hour-long token in one process's memory. A database
compromise yields installation ids, which are not credentials. The bind-mounted
checkout contains repository content and a credential-free remote.

What this costs:

- **A private clone cannot be retried from the workdir alone.** The token is
  gone; a retry mints a new one, which is fine, but nothing offline can re-fetch.
- **`http.extraheader` applies to every host git contacts during that command.**
  A repository with submodules on another host would send the header there.
  Submodules are not fetched (`--depth 1` without `--recurse-submodules`), so
  this is currently unreachable — but it is the reason point 4 checks the host
  rather than trusting the clone to stay on one.
- **The App must be registered by an operator**, with user authorization during
  installation enabled. There is no way to provision it from code, so a
  deployment missing any of `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID` or
  `GITHUB_APP_CLIENT_SECRET` has no repository access at all. The settings page
  says so rather than hiding the button.
- **Installing from GitHub's own App page does not connect anything.** That
  route carries no state, so the callback sends the person to settings to start
  again. Refusing is the only safe answer: without state there is nothing
  tying the installation to a session.

## Verification

`src/lib/runner/workdir.test.ts` clones a real repository with a token and
asserts that neither `.git/config` nor any other file under `.git` contains it,
and that the remote is the plain URL. Reverting to the URL form fails that test,
which is how it was checked.
