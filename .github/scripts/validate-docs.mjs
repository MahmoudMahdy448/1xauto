import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'codebase-analysis-docs');
const ARCHIVE_DIR = join(DOCS_DIR, 'archive');
const MANIFEST_PATH = join(REPO_ROOT, 'AI_MANIFEST.yaml');
const ENTRY_REL = 'codebase-analysis-docs/README_AI.md';

const VERSION_RE = /^\s*>\s*\*\*Version\*\*:?\s*(\d+\.\d+)/m;
const STATUS_RE = /\*\*Status\*\*:\s*\w+/;
const REPO_COMMIT_RE = /^\s*>\s*\*\*Repository Commit\*\*:\s*`?([0-9a-f]{7,40})/im;
const README_COMMIT_RE = /@\s*commit\s+`?([0-9a-f]{7,40})/i;
const CHANGELOG_HEADING_RE = /^##\s+v\d+\.\d+/m;
const ADR_HEADING_RE = /^##\s+(ADR-\d{2,3})\b/gm;
const ADR_REF_RE = /\bADR-\d{2,3}\b/g;
const REPO_PATH_RE = /^(?:codebase-analysis-docs\/|archive\/|AI_MANIFEST\.yaml)/;
const DOC_SUFFIX_RE = /\.(?:md|yaml|yml)$/;
const PLANNED_DOC_REFS = new Set(['codebase-analysis-docs/OPTIMIZATION_LOG.md']);
const BACKTICK_RE = /`([^`\n]+)`/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\n]+)\)/g;

const problems = [];
function fail(msg) { problems.push(msg); }
function pass(msg) { console.log('  ok  ' + msg); }

function isExternalLink(ref) {
  const r = ref.split('#')[0].trim();
  return !r || /^[a-z][a-z0-9+.-]*:\/\//i.test(r);
}

function resolveRef(fromFile, ref) {
  const clean = ref.split('#')[0].trim();
  const candidates = [resolve(dirname(fromFile), clean), resolve(REPO_ROOT, clean)];
  return candidates.find((p) => existsSync(p)) || null;
}

function readManifest() {
  const text = readFileSync(MANIFEST_PATH, 'utf8');
  const docsVersion = /^\s*docs_version:\s*(\d+\.\d+)\s*$/m.exec(text)?.[1];
  const analyzedCommit = /^\s*analyzed_commit:\s*([0-9a-f]{7,40})\s*$/m.exec(text)?.[1];
  const entry = /^entry_document:\s*(\S+)\s*$/m.exec(text)?.[1];
  const paths = [...text.matchAll(/^\s+path:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  return { docsVersion, analyzedCommit, entry, paths };
}

const manifest = readManifest();

if (!manifest.docsVersion) fail('AI_MANIFEST.yaml: missing docs_version (expect "x.y")');
else pass(`AI_MANIFEST.yaml: docs_version ${manifest.docsVersion}`);
if (!manifest.analyzedCommit) fail('AI_MANIFEST.yaml: missing analyzed_commit (expect 7+ hex)');
else pass(`AI_MANIFEST.yaml: analyzed_commit ${manifest.analyzedCommit}`);
if (!manifest.entry) fail('AI_MANIFEST.yaml: missing entry_document');
else if (manifest.entry !== ENTRY_REL) fail(`AI_MANIFEST.yaml: entry_document must be "${ENTRY_REL}"`);
else if (!existsSync(join(REPO_ROOT, manifest.entry))) fail(`AI_MANIFEST.yaml: entry_document does not exist (${manifest.entry})`);
else pass(`entry document exists: ${manifest.entry}`);

const manifestPaths = new Set([...(manifest.paths || []), ...(manifest.entry ? [manifest.entry] : [])]);
for (const p of manifestPaths) {
  if (existsSync(join(REPO_ROOT, p))) pass(`manifest path exists: ${p}`);
  else fail(`manifest path does not exist: ${p}`);
}

if (!existsSync(DOCS_DIR)) fail(`docs directory missing: ${DOCS_DIR}`);
if (!existsSync(ARCHIVE_DIR)) fail(`archive directory missing: ${ARCHIVE_DIR}`);

const expectedDocs = [
  'README_AI.md', 'CODEBASE_KNOWLEDGE.md', 'MIGRATION_AND_DEPLOYMENT_PLAN.md',
  'IMPLEMENTATION_ROADMAP.md', 'PROJECT_CONSTITUTION.md', 'ADR_LOG.md',
  'PHASES_TRACKER.md', 'CHANGELOG_AI.md',
];
const currentDocs = existsSync(DOCS_DIR)
  ? readdirSync(DOCS_DIR).filter((f) => statSync(join(DOCS_DIR, f)).isFile() && f.endsWith('.md'))
  : [];
for (const f of currentDocs) {
  if (!expectedDocs.includes(f)) fail(`stray file at docs root (register in AI_MANIFEST.yaml or move to archive/): ${f}`);
}
for (const f of expectedDocs) {
  if (!currentDocs.includes(f)) fail(`expected doc missing: ${f}`);
}

const definedAdrs = new Set();
if (existsSync(join(DOCS_DIR, 'ADR_LOG.md'))) {
  const adrText = readFileSync(join(DOCS_DIR, 'ADR_LOG.md'), 'utf8');
  for (const m of adrText.matchAll(ADR_HEADING_RE)) definedAdrs.add(m[1]);
  if (definedAdrs.size === 0) fail('ADR_LOG.md: no "## ADR-NNN" headings found');
  else pass(`ADR_LOG.md: ${[...definedAdrs].join(', ')}`);
}

for (const f of currentDocs) {
  const file = join(DOCS_DIR, f);
  const text = readFileSync(file, 'utf8');

  if (f === 'CHANGELOG_AI.md') {
    if (CHANGELOG_HEADING_RE.test(text)) pass(`${f}: revision log present`);
    else fail(`${f}: missing "## vN.N" revision heading`);
  } else {
    const vm = VERSION_RE.exec(text);
    if (!vm) fail(`${f}: missing "**Version**: x.y" header`);
    else {
      pass(`${f}: version ${vm[1]}`);
      if (!STATUS_RE.test(text)) fail(`${f}: missing "**Status**" header`);
    }
    if (f === 'README_AI.md') {
      const cm = README_COMMIT_RE.exec(text);
      if (!cm) fail(`${f}: missing "@ commit <hash>" reference`);
      else if (manifest.analyzedCommit && cm[1] !== manifest.analyzedCommit)
        fail(`${f}: commit ${cm[1]} != manifest analyzed_commit ${manifest.analyzedCommit}`);
      if (manifest.docsVersion && vm && vm[1] !== manifest.docsVersion)
        fail(`${f}: version ${vm[1]} != manifest docs_version ${manifest.docsVersion}`);
    }
    if (['CODEBASE_KNOWLEDGE.md', 'MIGRATION_AND_DEPLOYMENT_PLAN.md', 'IMPLEMENTATION_ROADMAP.md'].includes(f)) {
      const cm = REPO_COMMIT_RE.exec(text);
      if (!cm) fail(`${f}: missing "> **Repository Commit**: <hash>" header`);
      else if (manifest.analyzedCommit && cm[1] !== manifest.analyzedCommit)
        fail(`${f}: Repository Commit ${cm[1]} != manifest analyzed_commit ${manifest.analyzedCommit}`);
    }
  }

  for (const m of text.matchAll(BACKTICK_RE)) {
    const ref = m[1];
    if (!REPO_PATH_RE.test(ref) || !DOC_SUFFIX_RE.test(ref)) continue;
    if (PLANNED_DOC_REFS.has(ref)) continue;
    const resolved = resolveRef(file, ref);
    if (resolved) pass(`${f}: \`${ref}\` resolves`);
    else fail(`${f}: referenced path not found: \`${ref}\``);
  }

  for (const m of text.matchAll(MD_LINK_RE)) {
    const ref = m[1];
    if (isExternalLink(ref)) continue;
    const resolved = resolveRef(file, ref);
    if (resolved) pass(`${f}: link (${ref}) resolves`);
    else fail(`${f}: broken link: (${ref})`);
  }

  if (f !== 'ADR_LOG.md' && definedAdrs.size) {
    for (const m of text.matchAll(ADR_REF_RE)) {
      if (!definedAdrs.has(m[0])) fail(`${f}: references ${m[0]} not defined in ADR_LOG.md`);
    }
  }
}

if (problems.length) {
  console.error(`\nDocs validation FAILED (${problems.length}):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`\nDocs validation PASSED (${currentDocs.length} docs, ${manifestPaths.size} manifest paths).`);
