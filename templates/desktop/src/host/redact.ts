/**
 * Comprehensive log & diagnostic secret redaction covering:
 * - dsh query tokens & dsh-auth-* session cookies
 * - Authorization / Proxy-Authorization / x-api-key headers & Bearer tokens
 * - Provider & cloud API keys (sk-*, sk-ant-*, sk-proj-*, ghp_*, github_pat_*, AKIA*, AIza*)
 * - JWTs (eyJ...) and PEM private key blocks
 * - Embedded credentials in URLs (https://user:pass@host)
 * - Local OS username path segments
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '-----REDACTED PRIVATE KEY-----')
    .replace(/([?&#](?:token|api_?key|access_token|secret)=)[^&\s#]+/gi, '$1***')
    .replace(/\b((?:token|api_?key|access_token|secret)=)[^&\s#"';]+/gi, '$1***')
    .replace(/(dsh-auth-[^=;\s]+)=([^;\s]+)/gi, '$1=***')
    .replace(/\b((?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\r\n]+/gi, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***')
    .replace(/\b(x-api-key\s*:\s*)[^\r\n]+/gi, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,})\b/g, 'sk-***')
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, 'ghp_***')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, 'AKIA***')
    .replace(/\b(AIza[0-9A-Za-z_-]{20,})\b/g, 'AIza***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'eyJ***.***.***')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1***:***@')
    .replace(/([A-Za-z]:\\Users\\)([^\\/\s"']+)/g, '$1<user>')
    .replace(/(\/(?:Users|home)\/)([^/\s"']+)/g, '$1<user>')
}
