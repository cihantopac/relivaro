/**
 * Secret detection patterns. Shared by the secrets rule pack (detection) and by the redactor, which runs over
 * every string Relivaro emits so that no output format can leak a secret value.
 *
 * Patterns follow the documented token formats of each provider. Generic assignments are only reported when the
 * value looks random (Shannon entropy) and is not an obvious placeholder.
 */

export interface SecretPattern {
  id: string;
  name: string;
  regex: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  group: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Minimum entropy of the captured value, if the format alone is not distinctive. */
  minEntropy?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'private-key',
    name: 'Private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    group: 0,
    severity: 'critical',
  },
  {
    id: 'aws-access-key',
    name: 'AWS access key id',
    regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret access key',
    regex: /aws_?secret_?(?:access_?)?key["'\s]*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    group: 1,
    severity: 'critical',
    minEntropy: 4,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'github-fine-grained',
    name: 'GitHub fine-grained token',
    regex: /\b(github_pat_[A-Za-z0-9_]{82})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'gitlab-token',
    name: 'GitLab token',
    regex: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'slack-webhook',
    name: 'Slack webhook URL',
    regex: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]{20,})/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'stripe-live-key',
    name: 'Stripe live secret key',
    regex: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'stripe-test-key',
    name: 'Stripe test secret key',
    regex: /\b((?:sk|rk)_test_[A-Za-z0-9]{20,})\b/g,
    group: 1,
    severity: 'low',
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    group: 1,
    severity: 'medium',
  },
  {
    id: 'google-oauth-secret',
    name: 'Google OAuth client secret',
    regex: /\b(GOCSPX-[A-Za-z0-9_-]{28})\b/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'npm-token',
    name: 'npm access token',
    regex: /\b(npm_[A-Za-z0-9]{36})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'sendgrid-key',
    name: 'SendGrid API key',
    regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'openai-key',
    name: 'OpenAI API key',
    regex: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic API key',
    regex: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})\b/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'twilio-key',
    name: 'Twilio API key',
    regex: /\b(SK[0-9a-f]{32})\b/g,
    group: 1,
    severity: 'high',
    minEntropy: 3.3,
  },
  {
    id: 'mailgun-key',
    name: 'Mailgun API key',
    regex: /\b(key-[0-9a-f]{32})\b/g,
    group: 1,
    severity: 'high',
    minEntropy: 3.3,
  },
  {
    id: 'telegram-bot-token',
    name: 'Telegram bot token',
    regex: /\b(\d{8,10}:AA[A-Za-z0-9_-]{33})\b/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'discord-webhook',
    name: 'Discord webhook URL',
    regex: /(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,})/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'azure-storage-key',
    name: 'Azure storage account key',
    regex: /AccountKey=([A-Za-z0-9+/=]{86,88})/g,
    group: 1,
    severity: 'critical',
  },
  {
    id: 'laravel-app-key',
    name: 'Laravel APP_KEY',
    regex: /\bAPP_KEY\s*=\s*["']?(base64:[A-Za-z0-9+/=]{40,})/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'db-url-password',
    name: 'Connection string with password',
    regex:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/'"`]+:([^\s@/'"`]{4,})@[^\s'"`]+/g,
    group: 1,
    severity: 'high',
  },
  {
    id: 'jwt',
    name: 'JSON Web Token',
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    group: 1,
    severity: 'medium',
  },
];

/**
 * Generic `name = "value"` assignments whose name says secret. Evaluated separately because the value needs
 * entropy and placeholder checks.
 */
export const GENERIC_SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)\b["']?\s*(?:=|:|=>)\s*["'`]([^"'`\s]{8,200})["'`]/gi;

const PLACEHOLDER = new RegExp(
  [
    '^(?:x+|\\*+|\\.+|-+|_+|0+|1234.*|abc.*|test.*|dummy.*|sample.*|example.*|fake.*|mock.*|placeholder.*|changeme.*|change[_-]?me.*|secret|password|your[_-].*|my[_-].*|replace.*|todo.*|null|none|undefined|redacted.*|<.*>|\\{.*\\}|\\$\\{.*\\}|%.*%|\\[.*\\])$',
    '(?:example|placeholder|changeme|your[_-]?|xxxx|_here$|^\\$|process\\.env|getenv|env\\()',
  ].join('|'),
  'i',
);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /^[a-z]+(?:[_-][a-z]+)*$/.test(value) || /^[A-Z_]+$/.test(value);
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** `AKIA1234…` → `AKIA****************`: keeps a short prefix so the type stays recognisable. */
export function maskSecret(value: string): string {
  const keep = value.length >= 16 ? 4 : value.length >= 8 ? 2 : 0;
  return value.slice(0, keep) + '*'.repeat(Math.min(Math.max(value.length - keep, 4), 24));
}

/**
 * Removes secret values from arbitrary text. Applied to every snippet, command output and message before it is
 * written anywhere. Idempotent.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const p of SECRET_PATTERNS) {
    p.regex.lastIndex = 0;
    out = out.replace(p.regex, (match: string, ...groups: unknown[]) => {
      if (p.group === 0)
        return p.id === 'private-key' ? '-----BEGIN [REDACTED] PRIVATE KEY-----' : maskSecret(match);
      const value = groups[p.group - 1];
      if (typeof value !== 'string' || value.length === 0) return match;
      if (p.minEntropy && shannonEntropy(value) < p.minEntropy) return match;
      return match.replace(value, maskSecret(value));
    });
  }
  GENERIC_SECRET_ASSIGNMENT.lastIndex = 0;
  out = out.replace(GENERIC_SECRET_ASSIGNMENT, (match: string, _name: string, value: string) => {
    if (isPlaceholder(value) || shannonEntropy(value) < 3) return match;
    return match.replace(value, maskSecret(value));
  });
  return out;
}
