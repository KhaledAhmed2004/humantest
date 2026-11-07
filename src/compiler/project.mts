import fs from 'node:fs';
import path from 'node:path';

export interface UserConfig { email?: string; password?: string }

export interface HumanTestConfig {
  /** The project's name in the UI, e.g. "Dintel". */
  name?: string;
  baseURL: string;
  testsDir: string;
  statesDir: string;
  phrasesDir?: string;
  outDir: string;
  apiPrefix?: string;
  /** Hosts the page may call, e.g. ["localhost:5000"]. Calls anywhere else are blocked and fail the test. */
  apiHosts?: string[];
  login?: { endpoint: string; tokenCookie?: { name: string; from: string } };
  /** Where the app's own code is (for business logic discovery). Relative to this config file. */
  source?: { backend?: string; frontend?: string };
  /** Plain words for names in the code, used when rules are written out: { "isArch": "archived" }. */
  glossary?: Record<string, string>;
  /** Where the accepted business logic of each test is kept (commit it). Default: e2e/logic. */
  logicDir?: string;
  pages: Record<string, string>;
  users: Record<string, UserConfig>;
  elements?: Record<string, string>;
}

export interface Project {
  root: string;
  configPath: string;
  config: HumanTestConfig;
  testsDir: string;
  statesDir: string;
  phrasesDir: string;
  outDir: string;
}

export function loadProject(root = process.cwd()): Project {
  const configPath = path.join(root, 'humantest.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No humantest.config.json found in ${root}. Run this command from your project folder.`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as HumanTestConfig;
  return {
    root,
    configPath,
    config,
    testsDir: path.resolve(root, config.testsDir ?? 'e2e/tests'),
    statesDir: path.resolve(root, config.statesDir ?? 'e2e/states'),
    phrasesDir: path.resolve(root, config.phrasesDir ?? 'e2e/phrases'),
    outDir: path.resolve(root, config.outDir ?? 'e2e/.generated'),
  };
}

export const rel = (project: Project, file: string) => path.relative(project.root, file).split(path.sep).join('/');

export function listTestFiles(project: Project): string[] {
  if (!fs.existsSync(project.testsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ht')) out.push(p);
    }
  };
  walk(project.testsDir);
  return out.sort();
}
