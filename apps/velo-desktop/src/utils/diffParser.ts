export interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface ParsedFileDiff {
  filePath: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/**
 * Parses a unified `git diff` string into per-file structured diff blocks with exact dual-column line numbers.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedFileDiff[] {
  if (!rawDiff || !rawDiff.trim()) return [];

  const files: ParsedFileDiff[] = [];
  const chunks = rawDiff.split(/^diff --git /m).filter((c) => c.trim().length > 0);

  for (const chunk of chunks) {
    const rawLines = chunk.split("\n");
    const headerLine = rawLines[0] || "";
    const match = headerLine.match(/a\/(.+?)\s+b\/(.+)$/);
    const filePath = match ? match[2] : headerLine.trim();

    let additions = 0;
    let deletions = 0;
    let oldLine = 0;
    let newLine = 0;
    const parsedLines: DiffLine[] = [];

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode")
      ) {
        continue;
      }

      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLine = parseInt(hunkMatch[1], 10);
          newLine = parseInt(hunkMatch[2], 10);
        }
        parsedLines.push({
          type: "hunk",
          content: line,
          oldNumber: null,
          newNumber: null,
        });
      } else if (line.startsWith("+")) {
        additions++;
        parsedLines.push({
          type: "add",
          content: line.slice(1),
          oldNumber: null,
          newNumber: newLine++,
        });
      } else if (line.startsWith("-")) {
        deletions++;
        parsedLines.push({
          type: "del",
          content: line.slice(1),
          oldNumber: oldLine++,
          newNumber: null,
        });
      } else {
        parsedLines.push({
          type: "context",
          content: line.startsWith(" ") ? line.slice(1) : line,
          oldNumber: oldLine > 0 ? oldLine++ : null,
          newNumber: newLine > 0 ? newLine++ : null,
        });
      }
    }

    files.push({
      filePath,
      additions,
      deletions,
      lines: parsedLines,
    });
  }

  return files;
}
