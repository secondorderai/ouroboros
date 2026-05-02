const SENSITIVE_ENV_KEY_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OUROBOROS_OPENAI_COMPATIBLE_API_KEY',
])

const SENSITIVE_ENV_KEY_PATTERNS = [
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)(?:_|$)/i,
]

export function isSensitiveEnvKey(key: string): boolean {
  return (
    SENSITIVE_ENV_KEY_NAMES.has(key) ||
    SENSITIVE_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))
  )
}

export function scrubToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveEnvKey(key)) {
      scrubbed[key] = value
    }
  }
  return scrubbed
}
