/**
 * Security Scan Service
 *
 * Regex-based security checks for commit content. Detects:
 * - Hardcoded API keys and secrets
 * - SQL injection patterns
 * - Unsafe eval/exec usage
 * - Hardcoded passwords and credentials
 * - Private keys and tokens
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface SecurityFinding {
  rule: string;
  severity: Severity;
  message: string;
  /** Line number where the finding was detected (1-indexed) */
  line?: number;
  /** The matched text (truncated for secrets) */
  match?: string;
}

export interface SecurityScanResult {
  status: 'clean' | 'warning' | 'critical';
  findings: SecurityFinding[];
  summary: string;
}

interface ScanRule {
  name: string;
  pattern: RegExp;
  severity: Severity;
  message: string;
}

const SCAN_RULES: ScanRule[] = [
  {
    name: 'hardcoded_api_key',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi,
    severity: 'critical',
    message: 'Hardcoded API key detected',
  },
  {
    name: 'hardcoded_secret',
    pattern: /(?:secret|SECRET|client_secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
    severity: 'critical',
    message: 'Hardcoded secret detected',
  },
  {
    name: 'private_key',
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/gi,
    severity: 'critical',
    message: 'Private key embedded in code',
  },
  {
    name: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: 'critical',
    message: 'AWS access key ID detected',
  },
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    severity: 'critical',
    message: 'JWT token embedded in code',
  },
  {
    name: 'generic_token',
    pattern: /(?:token|TOKEN|bearer)\s*[:=]\s*['"][A-Za-z0-9_\-.]{32,}['"]/gi,
    severity: 'critical',
    message: 'Hardcoded token detected',
  },

  // ─── Warning: Unsafe Patterns ──────────────────────────────────────────
  {
    name: 'hardcoded_password',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    severity: 'warning',
    message: 'Hardcoded password detected',
  },
  {
    name: 'sql_injection',
    pattern: /(?:execute|query|raw)\s*\(\s*['"`].*\$\{/gi,
    severity: 'warning',
    message: 'Potential SQL injection: string interpolation in query',
  },
  {
    name: 'unsafe_eval',
    pattern: /\beval\s*\(/gi,
    severity: 'warning',
    message: 'Unsafe eval() usage detected',
  },
  {
    name: 'unsafe_exec',
    pattern: /(?:child_process|exec|execSync|spawn)\s*\(\s*(?:['"`]|`)/gi,
    severity: 'warning',
    message: 'Shell command execution detected — verify input sanitization',
  },
  {
    name: 'hardcoded_ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
    severity: 'info',
    message: 'Hardcoded IP address detected',
  },
  {
    name: 'console_log_sensitive',
    pattern: /console\.log\s*\(.*(?:password|secret|token|key|credential)/gi,
    severity: 'warning',
    message: 'Potentially logging sensitive data',
  },

  // ─── Info: Best Practice ───────────────────────────────────────────────
  {
    name: 'todo_fixme',
    pattern: /\/\/\s*(?:TODO|FIXME|HACK|XXX)\b/gi,
    severity: 'info',
    message: 'TODO/FIXME comment found',
  },
  {
    name: 'disabled_auth',
    pattern: /(?:auth|authentication|authorization)\s*[:=]\s*(?:false|disabled|off|none)/gi,
    severity: 'warning',
    message: 'Authentication appears to be disabled',
  },
];

/**
 * Run a security scan on the given content string.
 */
export function runSecurityScan(content: string): SecurityScanResult {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (const rule of SCAN_RULES) {
    // Reset regex state for global patterns
    rule.pattern.lastIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.pattern.exec(line)) !== null) {
        const matchText = match[0];
        // Truncate matched text to avoid exposing full secrets
        const truncated = matchText.length > 30
          ? matchText.substring(0, 15) + '...' + matchText.substring(matchText.length - 8)
          : matchText;

        findings.push({
          rule: rule.name,
          severity: rule.severity,
          message: rule.message,
          line: i + 1,
          match: truncated,
        });
      }
    }
  }

  // Determine overall status
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasWarning = findings.some(f => f.severity === 'warning');

  const status: SecurityScanResult['status'] = hasCritical
    ? 'critical'
    : hasWarning
      ? 'warning'
      : 'clean';

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;
  const infoCount = findings.filter(f => f.severity === 'info').length;

  let summary: string;
  if (findings.length === 0) {
    summary = 'No security issues found';
  } else {
    const parts: string[] = [];
    if (criticalCount > 0) parts.push(`${criticalCount} critical`);
    if (warningCount > 0) parts.push(`${warningCount} warning`);
    if (infoCount > 0) parts.push(`${infoCount} info`);
    summary = `Found ${findings.length} issue${findings.length > 1 ? 's' : ''}: ${parts.join(', ')}`;
  }

  return { status, findings, summary };
}
