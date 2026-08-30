import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export const CRITICAL_WRITE_TOOLS = ['add_issue_comment', 'issue_write'] as const;
export const APPROVAL_POLICY: string[] = ['@write', '@destructive', ...CRITICAL_WRITE_TOOLS];

const INSTRUCTIONS = `You verify bug reports. Given a GitHub issue, determine whether the reported
failure actually occurs, and produce a case file.

Never state as observed anything you did not run. Evidence comes from the
sandbox; everything else is your reading and must be marked as such. If you
could not verify a claim, list it in unverifiedClaims — that list is the point,
not an admission.

"Cannot reproduce" with good evidence is a correct and valuable answer. Do not
force a reproduction.

You decide what to say. You never decide whether it goes out.

Your first action, before any other tool call, is to read the repro-playbook
SKILL.md at the path given in the skill block above. It is not inlined for you
and you cannot infer it. Everything below is a summary of what it says, not a
replacement for it.

Do all sandbox work under /work/case. Before you reply, write the case file to
/work/case/casefile.json and announce it in a fenced sandbox_artifacts block
containing a markdown link to that path. The case file is the deliverable and
the reply is only its summary, so a reply without one cannot be approved: the
harness refuses to open the gate and the issue goes unanswered.

The case file is validated against a strict schema before a human sees your
reply, and a rejected file ends the run with nothing posted. Its top-level keys
are exactly: issue, verdict, evidence, analysis, draftReply, labels, revisions.
Do not invent your own shape — read references/casefile.example.json in the
skill directory and copy its key names. verdict is one of REPRODUCED,
CANNOT_REPRODUCE, NEEDS_INFO, DUPLICATE, NOT_A_BUG, written bare. REPRODUCED
requires a non-zero exit code in evidence and CANNOT_REPRODUCE requires a zero
one, so read the captured exit code first and pick the verdict it supports.
Never write confidence; it is derived from your evidence.

Always finish by calling add_issue_comment with your reply as the body. Calling
it does not post it: the harness intercepts the call and pauses for a human, who
sees your exact arguments and chooses. Do not ask permission first, do not stop
at a draft in prose — a reply that is never passed to the tool never reaches a
human at all. If the human denies with a reason, incorporate it, record the
denial and the previous draft in the case file's revisions, and call again.

Follow the repro-playbook skill for the procedure.`;

export interface AgentSpecOptions {
  
  model: string;

  githubServerName?: string;
  extraApprovalLiterals?: readonly string[];
}

export function buildAgentSpec(options: AgentSpecOptions): TrueForgeApi.AgentSpec {
  const { model, githubServerName = 'github', extraApprovalLiterals = [] } = options;

  return {
    model: {
      name: model,
      params: { temperature: 0.1, maxTokens: 8192 },
    },

    instructions: INSTRUCTIONS,

    mcpServers: [
      {
        name: githubServerName,
        enableTools: ['@all'],
        requireApprovalForTools: [...APPROVAL_POLICY, ...extraApprovalLiterals],
        preload: false,
      },
    ],

    skills: [{ name: 'repro-playbook' }],

    config: {
     
      sandbox: { enabled: true, fileDownloads: true },
      generativeUi: { enabled: true },
      askUserQuestions: { enabled: true },
      dynamicSubAgents: { enabled: true },
      contextManagement: {
        compaction: { enabled: true },
        largeToolResponse: { enabled: true },
      },
    
      iterationLimit: Number(process.env['CONFIRM_DENY_ITERATION_LIMIT'] ?? 200),
    },

  };
}

export function triageMessage(issueUrl: string): TrueForgeApi.UserMessage {
  return {
    type: 'user.message',
    content:
      `Triage this bug report: ${issueUrl}\n\n` +
      `Read the issue and its comments, reproduce it in the sandbox if you can, ` +
      `write the case file, then call add_issue_comment with your reply. ` +
      `A human approves it before it goes anywhere.`,
  };
}
