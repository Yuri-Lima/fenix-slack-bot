import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  errorFingerprint,
  expandErrorKeywords,
  extractBuildLogErrors,
  extractRealError,
  formatAnalysis,
  scoreCommitsForError,
} from '../../../listeners/events/teamcity-notify.js';

// Fixtures modelled on a real incident: a config failed 6 builds in a row
// (#328-#333) with the same error introduced in #328, but the bot blamed the
// author of #332's commits. Build numbers, messages and commits are synthetic.

const STATUS_333 =
  'Error message: GraphQL errors: Die Rechnung muss eine gültige Lieferadresse am Kunden haben.\n\n' +
  'Because this error occurred during a `before all` hook we are skipping the remaining tests ' +
  'in the current suite: `E-Invoice — every compatibl...`; exit code 4 (Step: Run E2E tests)';

const STATUS_328 =
  'Error message: GraphQL errors: Die Rechnung muss eine gültige Lieferadresse am Kunden haben.\n\n' +
  'Because this error occurred during a `before all` hook we are skipping the remaining tests ' +
  'in the current suite: `E-Invoice — every compatibl...` (new); exit code 4 (Step: Run E2E tests)';

const STATUS_DIFFERENT =
  'Error message: GraphQL errors: Produkt wurde nicht gefunden.\n\n' +
  'Because this error occurred during a `before all` hook we are skipping the remaining tests ' +
  'in the current suite: `E-Invoice — every compatibl...`; exit code 4 (Step: Run E2E tests)';

const STATUS_BOILERPLATE_ONLY =
  'Because this error occurred during a `before all` hook we are skipping the remaining tests ' +
  'in the current suite: `E-Invoice — every compatibl...`; exit code 4';

const STATUS_PLAIN_TESTS = 'Tests failed: 3 (2 new), passed: 120';

describe('extractRealError', () => {
  it('pulls the real error out of the statusText wrappers', () => {
    const { core, hookContext } = extractRealError(STATUS_333);
    assert.equal(core, 'Die Rechnung muss eine gültige Lieferadresse am Kunden haben.');
    assert.ok(hookContext);
    assert.equal(hookContext.hook, 'before all');
    assert.equal(hookContext.suite, 'E-Invoice — every compatibl...');
  });

  it('ignores the (new) marker TeamCity appends on first occurrence', () => {
    const { core } = extractRealError(STATUS_328);
    assert.equal(core, 'Die Rechnung muss eine gültige Lieferadresse am Kunden haben.');
  });

  it('returns an empty core for pure Cypress boilerplate', () => {
    const { core, hookContext } = extractRealError(STATUS_BOILERPLATE_ONLY);
    assert.equal(core, '');
    assert.ok(hookContext);
  });
});

describe('errorFingerprint', () => {
  it('matches the same real error across builds, (new) marker or not', () => {
    assert.ok(errorFingerprint(STATUS_333).length > 0);
    assert.equal(errorFingerprint(STATUS_333), errorFingerprint(STATUS_328));
  });

  it('distinguishes different root causes wrapped in identical boilerplate', () => {
    // The deployed bot compared the first 80 chars of the boilerplate line,
    // which made ANY two before-all failures in the same suite look identical.
    assert.notEqual(errorFingerprint(STATUS_333), errorFingerprint(STATUS_DIFFERENT));
  });

  it('refuses to fingerprint boilerplate-only or test-count statuses', () => {
    assert.equal(errorFingerprint(STATUS_BOILERPLATE_ONLY), '');
    assert.equal(errorFingerprint(STATUS_PLAIN_TESTS), '');
    assert.equal(errorFingerprint(''), '');
  });
});

describe('expandErrorKeywords', () => {
  it('maps German domain terms to English code naming', () => {
    const kws = expandErrorKeywords('Die Rechnung muss eine gültige Lieferadresse am Kunden haben.');
    assert.ok(kws.includes('invoice'));
    assert.ok(kws.includes('delivery'));
    assert.ok(kws.includes('address'));
  });

  it('drops filler words that would match random files', () => {
    const kws = expandErrorKeywords('Die Rechnung muss eine gültige Lieferadresse am Kunden haben.');
    assert.ok(!kws.includes('muss'));
    assert.ok(!kws.includes('eine'));
  });
});

describe('scoreCommitsForError', () => {
  // Commits of the build where the error first appeared, as returned by the
  // TeamCity changes API (synthetic data).
  const authorCommit = {
    version: 'a1b2c3d0000000000000000000000000000000000',
    username: 'alice.example',
    user: { name: 'Alice Example' },
    comment: 'IMPROVE: require a delivery address on invoices and validate the customer address link',
    files: {
      file: [
        { file: 'packages/api/e2e/invoice-delivery-address-subtest.ts' },
        { file: 'packages/api/src/models/invoices/invoice.model.ts' },
        { file: 'packages/api/src/resolver/invoice/invoice.resolver.ts' },
        { file: 'packages/api/src/services/customer-address-link.service.ts' },
        { file: 'packages/api/src/services/delivery-address.service.ts' },
        { file: 'packages/api/src/services/invoice/invoice.service.ts' },
        { file: 'packages/web/src/app/modules/invoices/controls/address-dropdown/address-dropdown.component.ts' },
      ],
    },
  };

  const otherCommit = {
    version: 'e4f5a6b000000000000000000000000000000000',
    username: 'bob.example',
    user: { name: 'Bob Example' },
    comment: 'Enhance invoice resolver and service with tag hydration logic',
    files: {
      file: [
        { file: 'packages/api/e2e/graphql/generated-e2e-admin-types.ts' },
        { file: 'packages/api/src/resolver/invoice/invoice.resolver.ts' },
        { file: 'packages/api/src/services/helpers/graphql-helper.spec.ts' },
        { file: 'packages/api/src/services/helpers/graphql-helper.ts' },
        { file: 'packages/api/src/services/invoice/invoice.service.ts' },
      ],
    },
  };

  const mergeCommit = {
    version: 'c7d8e9f000000000000000000000000000000000',
    username: 'alice.example',
    user: { name: 'Alice Example' },
    comment: "Merge branch 'main' of https://gitlab.example.com/acme/platform",
    files: {
      file: [
        { file: 'packages/api/src/resolver/invoice/invoice.resolver.ts' },
        { file: 'packages/api/src/services/invoice/invoice.service.ts' },
        { file: 'packages/api/src/services/customer.service.ts' },
        { file: 'packages/web/src/i18n-messages/en.json' },
      ],
    },
  };

  const ERROR = 'Die Rechnung muss eine gültige Lieferadresse am Kunden haben.';

  it('ranks the commit that introduced the delivery-address validation first', () => {
    const scored = scoreCommitsForError([otherCommit, mergeCommit, authorCommit], ERROR);
    assert.equal(scored[0].commit.version.slice(0, 7), 'a1b2c3d');
    assert.ok(scored[0].score > scored.find((s) => s.commit.username === 'bob.example').score);
  });

  it('surfaces the matched files as evidence', () => {
    const scored = scoreCommitsForError([authorCommit], ERROR);
    assert.ok(scored[0].matchedFiles.includes('delivery-address.service.ts'));
    assert.ok(scored[0].matchedFiles.includes('customer-address-link.service.ts'));
  });

  it('demotes merge commits relative to the same files in a real commit', () => {
    const realTwin = { ...mergeCommit, comment: 'Real change to the same files' };
    const [real] = scoreCommitsForError([realTwin], ERROR);
    const [merge] = scoreCommitsForError([mergeCommit], ERROR);
    assert.ok(merge.score < real.score);
  });

  it('skips commits without files', () => {
    const scored = scoreCommitsForError([{ version: 'abc', comment: 'Merge branch', files: { file: [] } }], ERROR);
    assert.equal(scored.length, 0);
  });
});

describe('extractBuildLogErrors', () => {
  it('drops Docker/corepack noise, boilerplate, and duplicates', () => {
    const log = [
      '[09:09:38] \t [Step 2/4] #68 [app-system packages 25/25] RUN npm install -g corepack && corepack enable && corepack prepare yarn@4.13.0 --activate && yarn install || (echo "ERROR: node_modules was not created by yarn install" && exit 1)',
      '[09:09:43] \t [Step 2/4] #68 [app-system packages 25/25] RUN npm install -g corepack && corepack enable && corepack prepare yarn@4.13.0 --activate && yarn install || (echo "ERROR: node_modules was not created by yarn install" && exit 1)',
      '[09:44:10] \t [Step 3/4] CypressError: `cy.request()` failed with error: Die Rechnung muss eine gültige Lieferadresse am Kunden haben.',
      '[09:44:10] \t [Step 3/4] CypressError: `cy.request()` failed with error: Die Rechnung muss eine gültige Lieferadresse am Kunden haben.',
      '[09:44:11] \t [Step 3/4] Because this error occurred during a `before all` hook we are skipping the remaining tests',
      "[09:44:50] Finished 2026-10-29 09:44:50 with status FAILURE 'Error message: GraphQL errors: ...'",
    ].join('\n');

    const errors = extractBuildLogErrors(log);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('Lieferadresse'));
  });
});

describe('formatAnalysis author ranking', () => {
  const commit = (sha, user, comment, files) => ({
    version: sha.padEnd(40, '0'),
    username: user,
    user: { name: user },
    comment,
    files: { file: files.map((f) => ({ file: f })) },
  });

  const analysis = (changes) => ({
    details: { id: 7, number: '7', buildType: { id: 'Main_E2e', name: 'Main E2E' }, statistics: { property: [] } },
    failures: { testOccurrence: [{ name: 'invoices: creates an invoice', newFailure: true, duration: 1000 }] },
    changes: { change: changes },
    flakyMap: new Map(),
    historicalFileFreq: new Map(),
    buildLogErrors: [],
    errorOrigin: null,
    originChanges: null,
  });

  it('ranks authors by score and lists their strongest commits first', () => {
    const text = formatAnalysis(
      analysis([
        commit('bbbbbbb', 'bob.example', 'Tweak README wording', ['README.md']),
        commit('aaaaaaa', 'alice.example', 'Invoice validation', ['packages/api/src/invoice/invoice.service.ts']),
      ]),
    );
    const lines = text.split('\n');
    const alice = lines.findIndex((l) => l.includes('*alice.example*'));
    const bob = lines.findIndex((l) => l.includes('*bob.example*'));
    assert.ok(alice !== -1 && bob !== -1, text);
    assert.ok(alice < bob, 'author whose files match the failing test ranks first');
    assert.match(lines[alice], /:first_place_medal:/);
    assert.match(lines[alice + 1], /`aaaaaaa0` Invoice validation/);
  });
});

// Fixtures modelled on a real incident: the kernel OOM killer SIGKILLed Jest
// workers on the agents for ~15 builds in a row. TeamCity reported each dead
// suite as a failed test occurrence, and the bot blamed the builds' commit
// authors. Names and commits are synthetic; the Jest strings are the real ones.
describe('formatAnalysis infra kills', () => {
  const JEST_SUITE_KILL = 'e2e: packages/api/e2e/order.e2e-spec.ts: Jest failed to execute suite';
  const SIGKILL_DETAILS =
    'Jest worker was terminated by another process: signal=SIGKILL, exitCode=null. ' +
    'Operating system logs may contain more information on why this occurred.';

  const commit = (sha, user, comment, files) => ({
    version: sha.padEnd(40, '0'),
    username: user,
    user: { name: user },
    comment,
    files: { file: files.map((f) => ({ file: f })) },
  });

  const analysis = (testOccurrence, changes) => ({
    details: {
      id: 9,
      number: '9',
      status: 'FAILURE',
      statusText: 'Tests failed: 15 (15 new)',
      buildType: { id: 'Main_E2e', name: 'Main E2E' },
      agent: { name: 'ci-agent-2' },
      statistics: { property: [] },
    },
    failures: { testOccurrence },
    changes: { change: changes },
    flakyMap: new Map(),
    historicalFileFreq: new Map(),
    buildLogErrors: [],
    errorOrigin: null,
    originChanges: null,
  });

  it('reports the kill as infra and does not rank commit authors', () => {
    const text = formatAnalysis(
      analysis(
        [
          { name: JEST_SUITE_KILL, newFailure: true },
          { name: 'ProductResolver (e2e): updates stock', newFailure: true, details: SIGKILL_DETAILS },
        ],
        [commit('aaaaaaa', 'alice.example', 'Order rework', ['packages/api/src/order/order.service.ts'])],
      ),
    );
    assert.match(text, /Infra: worker SIGKILLed \(2\)/);
    assert.match(text, /Check agent memory/);
    assert.match(text, /`journalctl -k` on ci-agent-2/);
    assert.ok(text.includes('packages/api/e2e/order.e2e-spec.ts'), text);
    assert.ok(!text.includes('Likely cause'), text);
    assert.ok(!text.includes('alice.example'), text);
    assert.ok(!text.includes('New failures'), text);
    assert.ok(!text.includes(':rotating_light:'), 'must not fall into build-error analysis');
  });

  it('still ranks commits for real new failures seen next to an infra kill', () => {
    const text = formatAnalysis(
      analysis(
        [
          { name: 'invoices: creates an invoice', newFailure: true, duration: 1000 },
          { name: JEST_SUITE_KILL, newFailure: true },
        ],
        [commit('aaaaaaa', 'alice.example', 'Invoice validation', ['packages/api/src/invoice/invoice.service.ts'])],
      ),
    );
    assert.match(text, /New failures \(1\)/);
    assert.match(text, /Likely cause/);
    assert.match(text, /alice\.example/);
    assert.match(text, /Infra: worker SIGKILLed \(1\)/);
  });
});
