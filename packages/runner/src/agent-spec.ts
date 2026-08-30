import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * The CONFIRM/DENY agent manifest.
 *
 * Most of this is API-only — it is not reachable from the stock UI, which is
 * part of why the harness is load-bearing here rather than decorative.
 */

/**
 * Calls whose gating is non-negotiable. Checked against the live tool list
 * before any session starts; see policy.ts.
 */
export const CRITICAL_WRITE_TOOLS = [
  'add_issue_comment',
  'update_issue_labels',
  'issue_write',
] as const;

/**
 * Both tags PLUS literals — all three parts are load-bearing:
 *
 *   · the list REPLACES the default, so omitting the tags discards them
 *   · `@write` excludes destructive tools, so `@destructive` is not redundant
 *   · literals are never validated, so they are a guarantee only once the
 *     preflight has confirmed they exist on this server
 *
 * The tags are the net; the literals are the guarantee for the demo-critical
 * calls. Neither half is sufficient alone.
 */
export const APPROVAL_POLICY: string[] = ['@write', '@destructive', ...CRITICAL_WRITE_TOOLS];

const INSTRUCTIONS = `You verify bug reports. Given a GitHub issue, determine whether the reported
failure actually occurs, and produce a case file.

Never state as observed anything you did not run. Evidence comes from the
sandbox; everything else is your reading and must be marked as such. If you
could not verify a claim, list it in unverifiedClaims — that list is the point,
not an admission.

"Cannot reproduce" with good evidence is a correct and valuable answer. Do not
force a reproduction.

You draft replies; you never decide to post them. Before any write to GitHub,
stop and present exactly what you intend to say. If the human denies with a
reason, incorporate it, record it in the case file's revisions, and ask again.

Follow the repro-playbook skill for the procedure.`;

export interface AgentSpecOptions {
  /** Model FQN, e.g. `anthropic/claude-sonnet-4-6`. */
  model: string;
  /** Configured MCP server name from Settings → Connectors. */
  githubServerName?: string;
  /** Extra literal tool names discovered on the live connection. */
  extraApprovalLiterals?: readonly string[];
}

export function buildAgentSpec(options: AgentSpecOptions): TrueForgeApi.AgentSpec {
  const { model, githubServerName = 'github', extraApprovalLiterals = [] } = options;

  return {
    model: {
      name: model,
      // A verdict, not prose. Determinism matters more than voice here.
      params: { temperature: 0.1, maxTokens: 8192 },
    },

    instructions: INSTRUCTIONS,

    mcpServers: [
      {
        name: githubServerName,
        enableTools: ['@all'],
        requireApprovalForTools: [...APPROVAL_POLICY, ...extraApprovalLiterals],
        // GitHub's MCP server exposes a lot of tools. Deferred discovery keeps
        // the context window for evidence rather than schemas.
        preload: false,
      },
    ],

    skills: [{ name: 'repro-playbook' }],

    config: {
      // Required for skills, and the whole reason this project exists: a
      // stranger's code runs here and nowhere else.
      sandbox: { enabled: true, fileDownloads: true },
      generativeUi: { enabled: true },
      askUserQuestions: { enabled: true },
      dynamicSubAgents: { enabled: true },
      contextManagement: {
        compaction: { enabled: true },
        largeToolResponse: { enabled: true },
      },
      // Below the default of 100, deliberately. A runaway triage loop burns
      // tokens and sandbox minutes with nothing to show for either.
      iterationLimit: 60,
    },

    // NO responseFormat. It is attached to EVERY LLM request in the thread, not
    // just the final answer — setting a json_schema here would force every
    // tool-calling turn and the draft reply at the gate into case-file JSON.
    // The case file is written into the sandbox and pulled out instead.
  };
}

/** The opening message: one issue URL in, one case file out. */
export function triageMessage(issueUrl: string): TrueForgeApi.UserMessage {
  return {
    type: 'user.message',
    content:
      `Triage this bug report: ${issueUrl}\n\n` +
      `Read the issue and its comments, reproduce it in the sandbox if you can, ` +
      `write the case file, and draft a reply. Do not post anything.`,
  };
}
