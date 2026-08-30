#!/usr/bin/env node
import { buildAgentSpec } from './agent-spec.ts';

const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const model = process.env['CONFIRM_DENY_MODEL'] ?? 'openrouter/glm-5-3-flash';
const githubServerName = process.env['GITHUB_MCP_SERVER'] ?? 'github';
const name = process.env['CONFIRM_DENY_AGENT'] ?? 'confirm-deny';

const manifest = buildAgentSpec({ model, githubServerName });

async function send(method: 'POST' | 'PUT', url: string): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, manifest }),
  });
}

const created = await send('POST', `${baseUrl}/api/v1/agents`);

if (created.ok) {
  const body = (await created.json()) as { data: { id: string } };
  console.log(`created agent "${name}" (${body.data.id})`);
} else if (created.status === 409) {
  const list = await fetch(`${baseUrl}/api/v1/agents`);
  const agents = (await list.json()) as { data: { id: string; name: string }[] };
  const existing = agents.data.find((a) => a.name === name);
  if (!existing) throw new Error(`agent "${name}" conflicts but is not listed`);

  const updated = await send('PUT', `${baseUrl}/api/v1/agents/${existing.id}`);
  if (!updated.ok) throw new Error(`update failed: ${updated.status} ${await updated.text()}`);
  console.log(`updated agent "${name}" (${existing.id})`);
} else {
  throw new Error(`create failed: ${created.status} ${await created.text()}`);
}

console.log(`model: ${model}`);
console.log(`open ${baseUrl} and start a session with it`);
