// Utility helpers used across pages

/** Generate a deterministic color from a string (for avatars, headers) */
export function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 60%, 45%)`;
}

/** Generate a lighter version for gradients */
export function stringToGradient(str: string): string {
  const color1 = stringToColor(str);
  const color2 = stringToColor(str + "_alt");
  return `linear-gradient(135deg, ${color1}, ${color2})`;
}

/** Format a date string relative to now */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return date.toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/** Format a number with commas */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Truncate an address */
export function truncateAddress(addr: string, chars = 6): string {
  if (addr.length <= chars * 2 + 2) return addr;
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
}

/** Role color mapping */
export function getRoleColor(role: string): {
  bg: string;
  text: string;
  border: string;
} {
  const map: Record<string, { bg: string; text: string; border: string }> = {
    researcher: {
      bg: "var(--accent-subtle)",
      text: "var(--accent-fg)",
      border: "var(--accent-muted)",
    },
    engineer: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
    },
    auditor: {
      bg: "var(--warning-subtle)",
      text: "var(--warning-fg)",
      border: "var(--warning-muted)",
    },
    "data-scientist": {
      bg: "rgba(137,87,229,0.15)",
      text: "var(--purple-fg)",
      border: "rgba(137,87,229,0.4)",
    },
    devops: {
      bg: "rgba(234,96,69,0.15)",
      text: "var(--coral-fg)",
      border: "rgba(234,96,69,0.4)",
    },
    frontend: {
      bg: "rgba(247,120,186,0.15)",
      text: "var(--pink-fg)",
      border: "rgba(247,120,186,0.4)",
    },
    architect: {
      bg: "var(--accent-subtle)",
      text: "var(--accent-fg)",
      border: "var(--accent-muted)",
    },
    qa: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
    },
  };
  return (
    map[role] ?? {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
    }
  );
}

/** Reasoning type badge style */
export function getReasoningTypeStyle(type: string): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  const map: Record<
    string,
    { bg: string; text: string; border: string; label: string }
  > = {
    knowledge: {
      bg: "var(--accent-subtle)",
      text: "var(--accent-fg)",
      border: "var(--accent-muted)",
      label: "Knowledge",
    },
    hypothesis: {
      bg: "rgba(137,87,229,0.15)",
      text: "var(--purple-fg)",
      border: "rgba(137,87,229,0.4)",
      label: "Hypothesis",
    },
    experiment: {
      bg: "var(--warning-subtle)",
      text: "var(--warning-fg)",
      border: "var(--warning-muted)",
      label: "Experiment",
    },
    conclusion: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
      label: "Conclusion",
    },
    trace: {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
      label: "Trace",
    },
  };
  return (
    map[type] ?? {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
      label: type,
    }
  );
}

/** Difficulty color mapping */
export function getDifficultyStyle(
  difficulty: string
): { bg: string; text: string; border: string } {
  const map: Record<string, { bg: string; text: string; border: string }> = {
    easy: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
    },
    medium: {
      bg: "var(--warning-subtle)",
      text: "var(--warning-fg)",
      border: "var(--warning-muted)",
    },
    hard: {
      bg: "var(--danger-subtle)",
      text: "var(--danger-fg)",
      border: "var(--danger-muted)",
    },
    expert: {
      bg: "rgba(137,87,229,0.15)",
      text: "var(--purple-fg)",
      border: "rgba(137,87,229,0.4)",
    },
  };
  return (
    map[difficulty] ?? {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
    }
  );
}

/** Issue status color mapping */
export function getStatusStyle(status: string): {
  bg: string;
  text: string;
  border: string;
} {
  const map: Record<string, { bg: string; text: string; border: string }> = {
    open: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
    },
    in_progress: {
      bg: "var(--warning-subtle)",
      text: "var(--warning-fg)",
      border: "var(--warning-muted)",
    },
    closed: {
      bg: "rgba(137,87,229,0.15)",
      text: "var(--purple-fg)",
      border: "rgba(137,87,229,0.4)",
    },
    cancelled: {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
    },
    merged: {
      bg: "rgba(137,87,229,0.15)",
      text: "var(--purple-fg)",
      border: "rgba(137,87,229,0.4)",
    },
    rejected: {
      bg: "var(--danger-subtle)",
      text: "var(--danger-fg)",
      border: "var(--danger-muted)",
    },
    approved: {
      bg: "var(--success-subtle)",
      text: "var(--success-fg)",
      border: "var(--success-muted)",
    },
  };
  return (
    map[status] ?? {
      bg: "rgba(110,118,129,0.15)",
      text: "var(--fg-muted)",
      border: "rgba(110,118,129,0.4)",
    }
  );
}
