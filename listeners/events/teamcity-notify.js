import { classifyTest, getTestHistory } from '../../agent/tools/flaky-tracker.js';
import { TC_BASE, tcApi, tcFetchText } from '../../agent/tools/teamcity.js';
import { config } from '../../config.js';
import { recordBuildResults } from '../../utils/flaky-store.js';
import { andMore, shortTestName } from '../../utils/helpers.js';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BUILD_URL_RE = TC_BASE ? new RegExp(`${escapeRegExp(TC_BASE)}/buildConfiguration/([^/|>]+)/(\\d+)`) : null;

export function parseBuildUrl(text) {
  const match = BUILD_URL_RE && text.match(BUILD_URL_RE);
  if (!match) return null;
  return { configId: match[1], buildId: Number.parseInt(match[2], 10) };
}

// ── Historical correlation ──────────────────────────────────────────────

/**
 * For each new failing test, find past builds where it also failed and
 * collect the files that changed in those builds. Returns a frequency map:
 * filePath -> number of past-failure builds it appeared in.
 * Also returns per-test evidence: testName -> [{ file, count }].
 */
async function getHistoricalCorrelation(newFailures, configId, currentBuildId) {
  const fileFreq = new Map();
  const fetchedBuilds = new Map();

  const testsToCheck = newFailures.slice(0, 5);

  for (const test of testsToCheck) {
    const name = test.name || '';
    if (!name) continue;

    let occData;
    try {
      occData = await tcApi(
        `/app/rest/testOccurrences?locator=test:(name:${encodeURIComponent(name)}),buildType:(id:${configId}),status:FAILURE,count:8&fields=testOccurrence(build(id))`,
      );
    } catch {
      continue;
    }

    const buildIds = (occData.testOccurrence || []).map((o) => o.build?.id).filter((id) => id && id !== currentBuildId);

    const uniqueIds = [...new Set(buildIds)].slice(0, 5);

    for (const bid of uniqueIds) {
      let changesForBuild = fetchedBuilds.get(bid);
      if (!changesForBuild) {
        try {
          const data = await tcApi(`/app/rest/changes?locator=build:(id:${bid})&fields=change(files(file(file)))`);
          changesForBuild = (data.change || []).flatMap((c) => (c.files?.file || []).map((f) => f.file));
          fetchedBuilds.set(bid, changesForBuild);
        } catch {
          fetchedBuilds.set(bid, []);
          continue;
        }
      }

      for (const filePath of changesForBuild) {
        const lower = filePath.toLowerCase();
        fileFreq.set(lower, (fileFreq.get(lower) || 0) + 1);
      }
    }
  }

  return fileFreq;
}

// ── Test-to-source naming map ───────────────────────────────────────────

/**
 * Extract module/entity names from a test name.
 * "ProductResolver (e2e) > should create" -> ["product"]
 * "WarehouseService (e2e) > stock" -> ["warehouse"]
 * "document-line-item.e2e-spec > ..." -> ["document-line-item"]
 */
function extractSourcePatterns(testName) {
  const patterns = new Set();

  const classMatch = testName.match(/(\w+?)(?:Resolver|Service|Controller|Guard|Module|Plugin|Component|Pipe)/i);
  if (classMatch) {
    const raw = classMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    patterns.add(raw);
  }

  const specMatch = testName.match(/([\w-]+)\.(?:e2e-spec|spec|test|cy)/i);
  if (specMatch) {
    patterns.add(specMatch[1].toLowerCase());
  }

  const suiteMatch = testName.match(/^([\w-]+)/);
  if (suiteMatch && suiteMatch[1].length > 3) {
    const raw = suiteMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    patterns.add(raw);
  }

  return [...patterns];
}

function fileMatchesPatterns(filePath, patterns) {
  const lower = filePath.toLowerCase();
  for (const p of patterns) {
    if (
      lower.includes(`/${p}.`) ||
      lower.includes(`/${p}/`) ||
      lower.includes(`${p}.resolver`) ||
      lower.includes(`${p}.service`) ||
      lower.includes(`${p}.entity`) ||
      lower.includes(`${p}.model`) ||
      lower.includes(`${p}.component`)
    ) {
      return p;
    }
  }
  return null;
}

// ── Keyword extraction ──────────────────────────────────────────────────

function extractTestKeywords(test) {
  const name = test?.name || '';
  const short = shortTestName(name).toLowerCase();
  const words = short
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 3);
  return words;
}

// ── Scoring (test-failure builds) ───────────────────────────────────────

/**
 * Score how likely a commit caused the new failures.
 * Returns { score, evidence[] } where evidence explains the signals found.
 */
function scoreCommitRelevance(commit, newFailures, historicalFileFreq) {
  const files = (commit.files?.file || []).map((f) => f.file.toLowerCase());
  if (files.length === 0) return { score: 0, evidence: [] };

  const evidence = [];
  let score = files.length;

  // Signal 1: keyword matching (baseline)
  const allKeywords = newFailures.flatMap(extractTestKeywords);
  for (const file of files) {
    for (const kw of allKeywords) {
      if (file.includes(kw)) score += 5;
    }
    if (file.includes('.spec.') || file.includes('.test.') || file.includes('/e2e/')) score += 2;
    if (file.endsWith('.ts') || file.endsWith('.js')) score += 1;
  }

  // Signal 2: historical correlation - files that changed in past builds where the same tests failed
  const histHits = [];
  for (const file of files) {
    const freq = historicalFileFreq.get(file) || 0;
    if (freq > 0) {
      score += freq * 10;
      histHits.push({ file, freq });
    }
  }
  if (histHits.length > 0) {
    histHits.sort((a, b) => b.freq - a.freq);
    const top = histHits[0];
    const shortFile = top.file.split('/').pop();
    evidence.push(
      `:chart_with_upwards_trend: \`${shortFile}\` changed in ${top.freq} past build${top.freq > 1 ? 's' : ''} where same tests failed`,
    );
  }

  // Signal 3: test-to-source naming - commit touches files matching the module under test
  const allPatterns = newFailures.flatMap((t) => extractSourcePatterns(t.name || ''));
  const patternHits = new Set();
  for (const file of files) {
    const matched = fileMatchesPatterns(file, allPatterns);
    if (matched) {
      score += 8;
      patternHits.add(matched);
    }
  }
  if (patternHits.size > 0) {
    const modules = [...patternHits]
      .slice(0, 2)
      .map((p) => `\`${p}\``)
      .join(', ');
    evidence.push(`:label: touches source for ${modules} tests`);
  }

  return { score, evidence };
}

// ── Real-error extraction from statusText ───────────────────────────────

/**
 * TeamCity's statusText carries the real failure reason, wrapped in noise:
 *   "Error message: GraphQL errors: Die Rechnung muss eine gültige
 *    Lieferadresse am Kunden haben. Because this error occurred during a
 *    `before all` hook we are skipping ... (new); exit code 4 (Step: ...)"
 * Strip the wrappers and the Cypress hook boilerplate so what remains is the
 * actual error. The boilerplate is identical for ANY setup failure in a
 * suite, so it must never be used to compare errors across builds.
 *
 * @param {string} statusText
 * @returns {{ core: string, hookContext: { hook: string, suite: string | null } | null }}
 */
export function extractRealError(statusText) {
  if (!statusText) return { core: '', hookContext: null };

  let t = String(statusText).replace(/\s+/g, ' ').trim();
  t = t.replace(/\(new\)/gi, ' ');
  t = t.replace(/;\s*exit cod[\s\S]*$/i, ' ');

  let hookContext = null;
  const hookMatch = t.match(/during an? `?([a-z ]+?)`? hook/i);
  if (hookMatch) {
    const suiteMatch = t.match(/current suite:\s*`([^`]+)`/i);
    hookContext = { hook: hookMatch[1].trim(), suite: suiteMatch ? suiteMatch[1] : null };
  }
  t = t.replace(/because this error occurred during [\s\S]*$/i, ' ');

  t = t.replace(/^error message:\s*/i, '');
  t = t.replace(/^graphql errors?:\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  return { core: t, hookContext };
}

/**
 * Normalized fingerprint of the REAL error for cross-build comparison.
 * Returns '' when the status carries no comparable error (plain test-count
 * statuses, or nothing left after stripping boilerplate) — in that case no
 * "same error as before" claim may be made.
 *
 * @param {string} statusText
 * @returns {string}
 */
export function errorFingerprint(statusText) {
  const { core } = extractRealError(statusText);
  const norm = core
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9äöüß# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm || norm.length < 15) return '';
  if (/^tests? failed[ :#(]/.test(norm)) return '';
  return norm.slice(0, 200);
}

// ── Error-to-commit scoring (bilingual codebase: German errors, English code) ──

const DOMAIN_TERMS = [
  [/bankkonto|bankverbindung/i, ['bank-account', 'bankaccount', 'bank_account']],
  [/mandant/i, ['tenant']],
  [/beleg/i, ['document']],
  [/rechnung/i, ['invoice']],
  [/steuer/i, ['tax', 'sales-tax']],
  [/liefer/i, ['delivery']],
  [/adresse/i, ['address']],
  [/zahlung/i, ['payment']],
  [/artikel|produkt/i, ['product']],
  [/kunde|debitor/i, ['debitor', 'customer']],
  [/kreditor/i, ['creditor']],
  [/lager|bestand/i, ['warehouse', 'stock']],
  [/auftrag|bestellung/i, ['order']],
  [/preis/i, ['price']],
  [/währung|waehrung/i, ['currency']],
];

const KEYWORD_STOPWORDS = new Set([
  'muss',
  'sein',
  'eine',
  'einer',
  'einem',
  'einen',
  'nicht',
  'kann',
  'darf',
  'wird',
  'werden',
  'wurde',
  'sind',
  'oder',
  'und',
  'beim',
  'nach',
  'vor',
  'this',
  'that',
  'with',
  'from',
  'have',
  'been',
  'must',
  'error',
  'errors',
  'graphql',
  'failed',
  'failure',
  'cannot',
  'because',
  'during',
  'hook',
  'suite',
  'tests',
  'remaining',
  'skipping',
  'current',
  'message',
]);

/**
 * Expand an error text into match keywords: significant words from the error
 * itself plus English code-naming equivalents of German domain terms, so
 * "Die Rechnung muss eine gültige Lieferadresse ..." can match files like
 * invoice.service.ts, delivery-address.service.ts, customer-address-link.service.ts.
 *
 * @param {string} errorText
 * @returns {string[]}
 */
export function expandErrorKeywords(errorText) {
  const text = errorText || '';
  const base = text
    .toLowerCase()
    .replace(/[^a-zäöüß0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 3 && !KEYWORD_STOPWORDS.has(w));
  const expanded = new Set(base);
  for (const [pattern, terms] of DOMAIN_TERMS) {
    if (pattern.test(text)) {
      for (const term of terms) expanded.add(term);
    }
  }
  return [...expanded];
}

/**
 * Score commits by how plausibly they caused the given error.
 * Signals: changed files matching error keywords (strongest), commit message
 * matching error keywords, code-file count (capped so bulk alone cannot win).
 * Merge commits are demoted — their file list usually mirrors someone else's work.
 *
 * @param {Array<{version?: string, username?: string, user?: {name?: string}, comment?: string, files?: {file?: Array<{file: string}>}}>} commits
 * @param {string} errorText
 * @returns {Array<{commit: object, score: number, matchedFiles: string[]}>} sorted desc by score
 */
export function scoreCommitsForError(commits, errorText) {
  const keywords = expandErrorKeywords(errorText);
  const spaceVariants = keywords.map((kw) => kw.replace(/[-_]/g, ' '));

  return commits
    .filter((c) => (c.files?.file?.length || 0) > 0)
    .map((c) => {
      const files = (c.files?.file || []).map((f) => f.file.toLowerCase());
      const matchedFiles = new Set();
      let codeFiles = 0;

      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.js')) codeFiles++;
        for (const kw of keywords) {
          if (file.includes(kw)) {
            matchedFiles.add(file.split('/').pop());
            break;
          }
        }
      }

      const comment = (c.comment || '').toLowerCase();
      let commentHits = 0;
      for (let i = 0; i < keywords.length; i++) {
        if (comment.includes(keywords[i]) || comment.includes(spaceVariants[i])) commentHits++;
      }

      let score =
        Math.min(files.length, 8) + Math.min(codeFiles, 8) + matchedFiles.size * 6 + Math.min(commentHits, 4) * 3;

      if (/^merge branch/i.test((c.comment || '').trim())) score = Math.round(score / 2);

      return { commit: c, score, matchedFiles: [...matchedFiles] };
    })
    .sort((a, b) => b.score - a.score);
}

// ── Build log helpers ──────────────────────────────────────────────────

export function extractBuildLogErrors(logText) {
  const DOCKER_NOISE =
    /\[[\w-]+ packages \d+\/\d+\]|RUN\s+(npm install|for i in|apk\s)|corepack\s+(prepare|enable)|yarn (install|cache|--version)|node_modules.*created by|echo "ERROR:/i;
  const lines = logText
    .split('\n')
    .map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\[[\d;]*m/g, '')
        .replace(/\r$/, '')
        .trim(),
    )
    .filter((l) => /\bFAIL[:\s]|error[:\s]/i.test(l))
    .filter((l) => !DOCKER_NOISE.test(l))
    .map((l) => l.replace(/^\[[\d:]+\]\s*(?:\w:)?\s*(\[Step \d+\/\d+\]\s*)?/, '').trim())
    .filter(
      (l) =>
        l.length > 15 &&
        !/^#\d+\s+\[/.test(l) &&
        !/^#\s*(fail|error)\s+\d+$/i.test(l) &&
        !/^(Finished |Changed build status|Build is failed|Step .+ failed$)/.test(l),
    )
    .filter((l) => !/^because this error occurred during /i.test(l));
  return [...new Set(lines)].slice(0, 5);
}

// ── Error-origin walk ───────────────────────────────────────────────────

/**
 * Walk recent builds (ALL statuses, newest first) backwards from the current
 * one to find where this exact error first appeared. The walk follows the
 * consecutive run of failures whose real-error fingerprint matches, and stops
 * at the first green build or at a failure with a different error. The build
 * whose commits deserve the blame is the ORIGIN of that streak — not the
 * build right before the current one.
 *
 * boundary: 'green' = streak starts right after a green build (clean origin),
 * 'other-error' = an unrelated failure sits behind the streak,
 * 'horizon' = streak extends past the fetched window.
 *
 * @returns {Promise<{buildId: number, buildNumber: string, priorFailures: number, lastGreenNumber: string | null, boundary: 'green' | 'other-error' | 'horizon'} | null>}
 */
async function findErrorOrigin(configId, currentBuildId, currentFingerprint) {
  if (!currentFingerprint) return null;

  let data;
  try {
    data = await tcApi(
      `/app/rest/builds?locator=buildType:(id:${configId}),count:20&fields=build(id,number,status,statusText)`,
    );
  } catch {
    return null;
  }

  const builds = data.build || [];
  const idx = builds.findIndex((b) => b.id === currentBuildId);
  const earlier = idx >= 0 ? builds.slice(idx + 1) : builds.filter((b) => b.id !== currentBuildId);

  let origin = null;
  let matchCount = 0;
  let lastGreenNumber = null;
  let boundary = 'horizon';

  for (const b of earlier) {
    if (b.status === 'SUCCESS') {
      if (origin) {
        boundary = 'green';
        lastGreenNumber = b.number;
      }
      break;
    }
    if (errorFingerprint(b.statusText || '') === currentFingerprint) {
      origin = b;
      matchCount++;
    } else {
      if (origin) boundary = 'other-error';
      break;
    }
  }

  if (!origin) return null;
  return { buildId: origin.id, buildNumber: origin.number, priorFailures: matchCount, lastGreenNumber, boundary };
}

// ── Build analysis ──────────────────────────────────────────────────────

async function analyzeBuild(buildId, configId) {
  const [details, failures, changes, problems] = await Promise.all([
    tcApi(
      `/app/rest/builds/id:${buildId}?fields=id,number,status,statusText,buildType(id,name),triggered(date,user(name)),agent(name),statistics(property(name,value))`,
    ),
    tcApi(
      `/app/rest/testOccurrences?locator=build:(id:${buildId}),status:FAILURE&fields=count,testOccurrence(name,newFailure,duration)`,
    ),
    tcApi(
      `/app/rest/changes?locator=build:(id:${buildId})&fields=change(id,version,username,user(name),comment,files(file(file)))`,
    ),
    tcApi(
      `/app/rest/problemOccurrences?locator=build:(id:${buildId})&fields=problemOccurrence(id,type,identity,details)`,
    ).catch(() => ({ problemOccurrence: [] })),
  ]);

  const tests = failures.testOccurrence || [];
  const toCheck = tests.slice(0, 15);
  const flakyMap = new Map();

  const historyChecks = toCheck.map(async (t) => {
    const name = t.name || '';
    if (!name) return;
    const hist = await getTestHistory(name, configId, 10);
    const classification = classifyTest(hist.rate, hist.total);
    if (classification === 'flaky') {
      flakyMap.set(name, Math.round(hist.rate * 100));
    }
  });
  await Promise.all(historyChecks);

  const newFailures = tests.filter((t) => t.newFailure && !flakyMap.has(t.name));

  let historicalFileFreq = new Map();
  if (newFailures.length > 0) {
    historicalFileFreq = await getHistoricalCorrelation(newFailures, configId, buildId);
  }

  let buildLogErrors = [];
  let errorOrigin = null;
  let originChanges = null;

  if (tests.length === 0) {
    try {
      const logText = await tcFetchText(`/downloadBuildLog.html?buildId=${buildId}&plain=true&lineCount=200`);
      buildLogErrors = extractBuildLogErrors(logText);
    } catch {
      // build log unavailable, statusText still carries the error
    }

    const fingerprint = errorFingerprint(details.statusText || '');
    errorOrigin = await findErrorOrigin(configId, buildId, fingerprint);

    if (errorOrigin) {
      try {
        const oc = await tcApi(
          `/app/rest/changes?locator=build:(id:${errorOrigin.buildId})&fields=change(id,version,username,user(name),comment,files(file(file)))`,
        );
        originChanges = (oc.change || []).filter((c) => (c.files?.file?.length || 0) > 0);
        if (originChanges.length === 0) originChanges = null;
      } catch {
        originChanges = null;
      }
    }
  }

  return {
    details,
    failures,
    changes,
    problems,
    flakyMap,
    historicalFileFreq,
    buildLogErrors,
    errorOrigin,
    originChanges,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────

function pushAuthorRanking(lines, scored) {
  const byAuthor = new Map();
  for (const { commit: c, score, matchedFiles } of scored) {
    const author = c.user?.name || c.username || 'unknown';
    if (!byAuthor.has(author))
      byAuthor.set(author, { commits: [], totalScore: 0, totalFiles: 0, matchedFiles: new Set() });
    const entry = byAuthor.get(author);
    entry.commits.push({ commit: c, score });
    entry.totalScore += score;
    entry.totalFiles += c.files?.file?.length || 0;
    for (const f of matchedFiles) entry.matchedFiles.add(f);
  }

  const sorted = [...byAuthor.entries()].sort((a, b) => b[1].totalScore - a[1].totalScore);
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];

  sorted.forEach(([author, data], i) => {
    const rank = medals[i] || `#${i + 1}`;
    lines.push(
      `  ${rank} *${author}* (${data.commits.length} commit${data.commits.length > 1 ? 's' : ''}, ${data.totalFiles} files)`,
    );
    const top = data.commits.sort((a, b) => b.score - a.score).slice(0, 2);
    for (const { commit: c } of top) {
      const sha = (c.version || '').slice(0, 8);
      const comment = (c.comment || '').split('\n')[0].trim();
      lines.push(`      \`${sha}\` ${comment.slice(0, 100)}`);
    }
    const moreCommits = andMore(data.commits.length, 2, '      ');
    if (moreCommits) lines.push(moreCommits);
    const mf = [...data.matchedFiles].slice(0, 3);
    if (mf.length > 0) {
      lines.push(`      :label: touches \`${mf.join('`, `')}\``);
    }
  });
}

export function formatAnalysis({
  details,
  failures,
  changes,
  flakyMap,
  historicalFileFreq,
  buildLogErrors,
  errorOrigin,
  originChanges,
}) {
  const b = details;
  const tests = failures.testOccurrence || [];
  const commits = changes.change || [];

  const netProp = b.statistics?.property?.find((p) => p.name === 'BuildDurationNetTime');
  const fallbackProp = b.statistics?.property?.find((p) => p.name === 'BuildDuration');
  const durationMs = Number.parseInt((netProp || fallbackProp)?.value || '0');
  const totalMin = Math.round(durationMs / 60000);
  const durationMin = totalMin >= 60 ? `${Math.floor(totalMin / 60)}h ${totalMin % 60}m` : `${totalMin} min`;

  const newFailures = tests.filter((t) => t.newFailure);
  const preExisting = tests.filter((t) => !t.newFailure);

  const realNew = newFailures.filter((t) => !flakyMap.has(t.name));
  const flakyNew = newFailures.filter((t) => flakyMap.has(t.name));
  const flakyPre = preExisting.filter((t) => flakyMap.has(t.name));
  const brokenPre = preExisting.filter((t) => !flakyMap.has(t.name));
  const totalFlaky = flakyNew.length + flakyPre.length;

  const buildLink = `${TC_BASE}/buildConfiguration/${b.buildType?.id}/${b.id}`;
  const configName = b.buildType?.name || b.buildType?.id;
  const agentName = b.agent?.name || '?';

  const lines = ['*Build Failure Analysis*'];
  lines.push(`\`${configName}\` | ${durationMin} | ${agentName} | <${buildLink}|View build>`);

  if (realNew.length > 0) {
    lines.push('');
    lines.push(`*:red_circle: New failures (${realNew.length}):*`);
    for (const t of realNew.slice(0, 10)) {
      const dur = t.duration ? ` (${(t.duration / 1000).toFixed(1)}s)` : '';
      lines.push(`  - \`${shortTestName(t.name)}\`${dur}`);
    }
    const moreNew = andMore(realNew.length, 10);
    if (moreNew) lines.push(moreNew);

    // Likely cause with enriched scoring
    const realCommits = commits.filter((c) => (c.files?.file?.length || 0) > 0);
    if (realCommits.length > 0) {
      const scored = realCommits
        .map((c) => ({ commit: c, ...scoreCommitRelevance(c, realNew, historicalFileFreq) }))
        .sort((a, b) => b.score - a.score);

      const byAuthor = new Map();
      for (const { commit: c, score, evidence } of scored) {
        const author = c.user?.name || c.username || 'unknown';
        if (!byAuthor.has(author)) byAuthor.set(author, { commits: [], totalScore: 0, totalFiles: 0, evidence: [] });
        const entry = byAuthor.get(author);
        entry.commits.push(c);
        entry.totalScore += score;
        entry.totalFiles += c.files?.file?.length || 0;
        for (const e of evidence) {
          if (!entry.evidence.includes(e)) entry.evidence.push(e);
        }
      }

      const sortedAuthors = [...byAuthor.entries()].sort((a, b) => b[1].totalScore - a[1].totalScore);

      lines.push('');
      lines.push('*:bust_in_silhouette: Likely cause:*');

      const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
      sortedAuthors.forEach(([author, data], i) => {
        const rank = medals[i] || `#${i + 1}`;
        const topCommits = data.commits
          .sort((a, b) => (b.files?.file?.length || 0) - (a.files?.file?.length || 0))
          .slice(0, 3);
        lines.push(
          `  ${rank} *${author}* (${data.commits.length} commit${data.commits.length > 1 ? 's' : ''}, ${data.totalFiles} files)`,
        );
        for (const c of topCommits) {
          const sha = (c.version || '').slice(0, 8);
          const comment = (c.comment || '').split('\n')[0].trim();
          lines.push(`      \`${sha}\` ${comment}`);
        }
        const moreCommits = andMore(data.commits.length, 3, '      ');
        if (moreCommits) lines.push(moreCommits);
        for (const e of data.evidence.slice(0, 2)) {
          lines.push(`      ${e}`);
        }
      });
    }
  }

  if (totalFlaky > 0) {
    const allFlaky = [...flakyNew, ...flakyPre];
    lines.push('');
    lines.push(`*:recycle: Flaky tests (${totalFlaky}):*`);
    for (const t of allFlaky.slice(0, 8)) {
      const pct = flakyMap.get(t.name) || '?';
      lines.push(`  - \`${shortTestName(t.name)}\` (${pct}% fail rate)`);
    }
    const moreFlaky = andMore(allFlaky.length, 8);
    if (moreFlaky) lines.push(moreFlaky);
  }

  if (brokenPre.length > 0) {
    lines.push('');
    lines.push(`*:large_yellow_circle: Pre-existing (${brokenPre.length}):*`);
    for (const t of brokenPre.slice(0, 5)) {
      lines.push(`  - \`${shortTestName(t.name)}\``);
    }
    const morePre = andMore(brokenPre.length, 5);
    if (morePre) lines.push(morePre);
  }

  if (tests.length === 0) {
    lines.push('');

    const { core: coreError, hookContext } = extractRealError(b.statusText || '');

    if (coreError) {
      lines.push(`*:rotating_light: Build error:* ${coreError.slice(0, 300)}`);
      if (hookContext) {
        const suite = hookContext.suite ? `, suite \`${hookContext.suite}\` was skipped` : '';
        lines.push(`  _failed in a \`${hookContext.hook}\` hook${suite}_`);
      }
    }

    const coreSnippet = coreError ? coreError.slice(0, 40) : null;
    const extraErrors = (buildLogErrors || []).filter((e) => !coreSnippet || !e.includes(coreSnippet));
    if (extraErrors.length > 0) {
      if (!coreError) lines.push('*:rotating_light: Build errors:*');
      for (const err of extraErrors.slice(0, coreError ? 2 : 5)) {
        lines.push(`  - ${err.slice(0, 300)}`);
      }
    }

    if (!coreError && extraErrors.length === 0) {
      lines.push('_No test failures and no build problems reported._');
    }

    const currentCommits = commits.filter((c) => (c.files?.file?.length || 0) > 0);
    const errorForScoring = coreError || (buildLogErrors || []).join(' ') || b.statusText || '';

    if (errorOrigin) {
      const originLink = `${TC_BASE}/buildConfiguration/${b.buildType?.id}/${errorOrigin.buildId}`;
      const streak = errorOrigin.priorFailures + 1;
      const since =
        errorOrigin.boundary === 'green'
          ? `first failed in <${originLink}|#${errorOrigin.buildNumber}>${errorOrigin.lastGreenNumber ? ` (last green: #${errorOrigin.lastGreenNumber})` : ''}`
          : `failing since at least <${originLink}|#${errorOrigin.buildNumber}>`;
      lines.push('');
      lines.push(`*:large_yellow_circle: Not a new error:* ${since}, ${streak} builds in a row with this exact error.`);

      if (originChanges) {
        const scored = scoreCommitsForError(originChanges, errorForScoring);
        if (scored.length > 0) {
          lines.push('');
          lines.push(
            `*:bust_in_silhouette: Likely cause, commits in #${errorOrigin.buildNumber} (where the error first appeared):*`,
          );
          pushAuthorRanking(lines, scored);
        }
      }

      if (currentCommits.length > 0) {
        lines.push('');
        lines.push('*Commits in this build* (_error predates them, probably not the cause_):');
        for (const c of currentCommits.slice(0, 4)) {
          const author = c.user?.name || c.username || 'unknown';
          const sha = (c.version || '').slice(0, 8);
          const comment = (c.comment || '').split('\n')[0].trim();
          lines.push(`  - ${author}: \`${sha}\` ${comment.slice(0, 90)}`);
        }
        const moreC = andMore(currentCommits.length, 4);
        if (moreC) lines.push(moreC);
      }
    } else if (currentCommits.length > 0) {
      const scored = scoreCommitsForError(currentCommits, errorForScoring);
      lines.push('');
      lines.push('*:bust_in_silhouette: Likely cause (error is new in this build):*');
      pushAuthorRanking(lines, scored);
    } else {
      lines.push('');
      lines.push('_No code changes in this build. Likely an infrastructure or environment issue._');
    }
  }

  return lines.join('\n');
}

/**
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 */
export async function handleTeamCityNotify({ client, event, logger }) {
  if (!config.teamcity.botId || event.bot_id !== config.teamcity.botId) return;
  if (!event.text?.includes('*failed*')) return;

  const parsed = parseBuildUrl(event.text);
  if (!parsed) return;

  try {
    const analysis = await analyzeBuild(parsed.buildId, parsed.configId);

    const allTests = analysis.failures.testOccurrence || [];
    if (allTests.length > 0) {
      try {
        const results = allTests.map((t) => ({ name: t.name, status: 'FAILURE' }));
        recordBuildResults(parsed.configId, parsed.buildId, analysis.details.number || '', results, shortTestName);
      } catch (storeErr) {
        logger.error(`Flaky store write failed: ${storeErr}`);
      }
    }

    const message = formatAnalysis(analysis);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: message,
      unfurl_links: false,
    });
  } catch (err) {
    logger.error(`TeamCity notify analysis failed for build ${parsed.buildId}: ${err}`);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:warning: Could not analyze build ${parsed.buildId}: ${err.message}`,
    });
  }
}
