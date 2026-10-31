import type { RelivaroConfig } from '../core/config.js';
import type { Category, Confidence, Language, ProjectFile, Severity } from '../core/types.js';
import type { FileSet } from '../fs/files.js';
import type { ProjectProfile } from '../intel/discover.js';
import type { CallInfo } from '../parse/ast.js';
import type { Node, Tree } from '../parse/treesitter.js';

export interface RuleMeta {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  /** What the rule detects and why it matters (rendered in docs/RULES.md and SARIF help). */
  description: string;
  impact: string;
  recommendation: string;
  verification: string;
  cwe?: string[];
  owasp?: string[];
  tags?: string[];
  fixer?: string;
  references?: string[];
}

/** One detection produced by a rule; the engine turns it into a full Finding. */
export interface Hit {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  node?: Node;
  message: string;
  severity?: Severity;
  confidence?: Confidence;
  facts?: Record<string, string | number | boolean | null>;
  /** Text used for the fingerprint instead of the source line (e.g. a package name). */
  anchor?: string;
  /** Pre-redacted snippet to use instead of source lines. */
  snippet?: string;
  /** Override the fixer for this particular hit (or disable with null). */
  fixer?: string | null;
}

export interface ProjectContext {
  files: FileSet;
  profile: ProjectProfile;
  config: RelivaroConfig;
}

export interface AstContext {
  project: ProjectContext;
  file: ProjectFile;
  lang: Language;
  source: string;
  tree: Tree;
  /** All calls in the file (computed once per file). */
  calls: CallInfo[];
  /** True when the expression carries user input in its function scope. */
  tainted(expr: Node | null | undefined): boolean;
  /** True when the file looks like server-side code (route handler, controller, API, worker). */
  serverSide: boolean;
}

export interface FileContext {
  project: ProjectContext;
  file: ProjectFile;
  text: string;
  lines: string[];
}

export interface AstRule extends RuleMeta {
  kind: 'ast';
  languages: Language[];
  check(ctx: AstContext): Hit[];
}

export interface FileRule extends RuleMeta {
  kind: 'file';
  appliesTo(file: ProjectFile): boolean;
  check(ctx: FileContext): Hit[];
}

export interface ProjectRule extends RuleMeta {
  kind: 'project';
  check(ctx: ProjectContext): Hit[];
}

export type Rule = AstRule | FileRule | ProjectRule;

export const ALL_LANGS: Language[] = ['javascript', 'typescript', 'tsx', 'php', 'python'];
export const JS_LANGS: Language[] = ['javascript', 'typescript', 'tsx'];
