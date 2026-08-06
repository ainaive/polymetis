/**
 * M2 validation spike — NOT production code.
 *
 * Answers the one question M2 rests on: does "issue + repo → implementation
 * spec" produce something a senior engineer says saved them time? Everything
 * else in M2 (the queue, the sandbox, the SSE relay) is well-understood
 * plumbing; this is the part that could invalidate the wedge.
 *
 * The test is retrospective. It runs against a git worktree pinned to the
 * commit BEFORE a feature landed, so the spec it produces can be diffed
 * against what was actually built. Running against current HEAD would let the
 * agent read the finished implementation and describe it back, which proves
 * nothing.
 *
 * It deliberately imports the real template contract from
 * src/lib/templates/issue-to-spec.ts rather than a copy — the directives and
 * tool policy are under test here too.
 *
 *   ANTHROPIC_API_KEY=... bun run scripts/spike/issue-to-spec.ts <repo-path>
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  issueToSpecDeliverable,
  issueToSpecDirectives,
  issueToSpecToolPolicy,
} from "@/lib/templates/issue-to-spec";

const repoPath = process.argv[2];
if (!repoPath) {
  console.error("usage: bun run scripts/spike/issue-to-spec.ts <repo-path>");
  process.exit(1);
}

/**
 * The issue as it would have been filed before the feature existed: it states
 * the constraint and leaves the approach open. Describing the solution here
 * would make the test trivially passable.
 */
const ISSUE = `Title: Support deployment without a long-running worker process

Sodalis currently needs a separate always-on worker (\`bun run worker\`) to drive
the scheduler. That rules out hosting platforms that cannot keep a process
alive and only offer scheduled HTTP invocations.

We want to be able to deploy Sodalis to one of those platforms. Work out what
has to change for the scheduler to run correctly under that model, and what
else in the app is affected by not having a persistent process.`;

const prompt = `${issueToSpecDirectives}

---

The repository is at the current working directory. Here is the issue:

${ISSUE}

Write your spec to ${issueToSpecDeliverable.filename} in the repository root.`;

console.log(`repo:  ${repoPath}`);
console.log(`model: claude-opus-5 (effort xhigh)`);
console.log(`tools: ${issueToSpecToolPolicy.allow.join(", ")}`);
console.log(`denied: ${issueToSpecToolPolicy.deny.join(", ")}\n`);

const started = Date.now();
let turns = 0;

const response = query({
  prompt,
  options: {
    cwd: repoPath,
    model: "claude-opus-5",
    effort: "xhigh",
    // Enforce the template's tool policy. Denying Bash does double duty here:
    // it is what ADR-0002 requires, and it stops the agent running `git log`
    // and reading the very commits this test is meant to predict.
    allowedTools: [...issueToSpecToolPolicy.allow],
    disallowedTools: [...issueToSpecToolPolicy.deny],
    // Do not inherit the developer's personal CLAUDE.md or settings. The run
    // must depend only on the template contract, and in M2 the sandbox will
    // have no such config to inherit anyway.
    settingSources: [],
    permissionMode: "bypassPermissions",
    maxTurns: 80,
  },
});

for await (const message of response) {
  switch (message.type) {
    case "assistant": {
      turns++;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(`\n▸ ${block.text.trim().slice(0, 400)}`);
        } else if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          const detail =
            input.file_path ?? input.pattern ?? input.path ?? input.command ?? "";
          console.log(`  · ${block.name} ${String(detail).slice(0, 90)}`);
        }
      }
      break;
    }
    case "result": {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\n${"─".repeat(60)}`);
      if (message.subtype === "success") {
        console.log(`done in ${elapsed}s · ${message.num_turns} turns`);
        console.log(`cost: $${message.total_cost_usd.toFixed(4)}`);
        console.log(
          `tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`,
        );
        console.log(`spec written to ${repoPath}/${issueToSpecDeliverable.filename}`);
      } else {
        console.error(`FAILED after ${elapsed}s: ${message.subtype}`);
        process.exit(1);
      }
      break;
    }
  }
}

console.log(`(${turns} assistant turns observed)`);
