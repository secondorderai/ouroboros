// Return fixed labels only; server diagnostics may contain private data.
export function failureSignals(diagnostic: string): string[] {
  const patterns: Record<string, RegExp> = {
    unavailable_model:
      /model_not_found|model[^\n]*(?:not found|not available|not supported|does not exist)|(?:unknown|invalid|unsupported)[^\n]*model/i,
    unsupported_reasoning:
      /(?:reasoning|xhigh)[^\n]*(?:not supported|unsupported|invalid)|unsupported[^\n]*(?:reasoning|xhigh)/i,
    invalid_schema: /invalid_json_schema|invalid schema|response_format|text\.format\.schema/i,
    schema_required_fields:
      /additionalProperties|required.*(?:supplied|false|property)|minLength|anyOf/i,
    authentication: /refresh_token|unauthorized|authentication|\b401\b/i,
    subscription_allowance:
      /usage_limit_reached|usage limit|rate_limit_exceeded|rate limit|\b429\b/i,
    forbidden: /\b403\b|forbidden|access denied/i,
    configuration:
      /error loading config|failed to (?:load|parse).*config|invalid (?:value|type).*config/i,
    cli_arguments: /unexpected argument|unrecognized option|required arguments|invalid value/i,
    sandbox: /sandbox|bwrap|bubblewrap|landlock|operation not permitted|permission denied/i,
    network:
      /failed to connect|connection (?:refused|reset|closed)|dns|certificate|tls|websocket|stream disconnected/i,
    http_bad_request: /\b400\b|bad request/i,
    server_failure: /\b50[0234]\b|internal server error|service unavailable/i,
    context_limit: /context_length_exceeded|context (?:length|window)|too many tokens/i,
    missing_session: /session[^\n]*(?:not found|does not exist)|no session found/i,
  }
  return Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(diagnostic))
    .map(([key]) => key)
}
