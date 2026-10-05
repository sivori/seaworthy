// Confirmation tokens for irreversible tools.
//
// A token is a hash of the tool name plus the plan it would run. Called without
// a token, a tool returns its plan and the token; called with one, it rebuilds
// the plan from live state and runs only if the hash still matches. That makes
// the server stateless and means a token goes stale on its own the moment
// anything relevant changes (a new build lands, a submission moves), so Claude
// can't skip from intent to execution, and a person approves what will
// actually happen.

import { createHash } from 'node:crypto';

const stable = (x) =>
  Array.isArray(x)
    ? `[${x.map(stable).join(',')}]`
    : x && typeof x === 'object'
      ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`
      : JSON.stringify(x);

export function planToken(tool, plan) {
  return createHash('sha256').update(`${tool}\n${stable(plan)}`).digest('hex').slice(0, 12);
}

/**
 * @returns {{ run: true } | { run: false, response: object }}
 */
export function gate(tool, plan, confirm, describe) {
  const token = planToken(tool, plan);
  if (confirm === token) return { run: true };
  return {
    run: false,
    response: {
      confirmation_required: true,
      ...(confirm ? { note: 'The token did not match: the plan changed since it was issued. Review the new plan below.' } : {}),
      plan: describe,
      confirm: token,
      instructions: `Nothing has been done. Show this plan to the user and ask for an explicit yes. Only then call ${tool} again with the same arguments plus confirm: "${token}".`,
    },
  };
}
