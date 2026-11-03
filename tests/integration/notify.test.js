// Process-level tests for scripts/notify.js recipient routing.
//
// The channel is for screenshots only. A batch summary is operational
// reporting and must stay in the admin chat; it used to go to both, and it was
// posted twice per batch because scheduled-run ran notify as a step and again
// as the final pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { startFakeTelegram } from '../helpers/fake-telegram.mjs';
import { ROOT, baseEnv, spawnScript, tempRoot, writeJson } from '../helpers/process.mjs';

const ADMIN = '699397575';
const CHANNEL = '-1004357023695';

function seed(root) {
  const screenshots = path.join(root, 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  const shot = path.join(screenshots, 'vodafone-01011112222.png');
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  writeJson(path.join(root, 'run-summary.json'), {
    batchId: 'test-batch',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    totalAccounts: 10,
    startIndex: 1,
    lastProcessedIndex: 10,
    succeeded: 9,
    failed: 1,
    uniqueNumbers: 1,
    screenshotsRetained: 1,
    durationMs: 60_000,
    artifactNames: ['screenshots/vodafone-01011112222.png']
  });

  return { screenshots, shot };
}

test('the batch summary stays in the admin chat; screenshots go to chat and channel', async () => {
  const root = tempRoot('notify');
  seed(root);
  const tg = await startFakeTelegram();

  try {
    const child = spawnScript(path.join(ROOT, 'scripts/notify.js'), {
      cwd: root,
      env: baseEnv({
        telegramUrl: tg.baseUrl,
        root,
        extra: {
          RUN_SUMMARY_FILE: path.join(root, 'run-summary.json'),
          SCREENSHOTS_DIR: path.join(root, 'screenshots')
        }
      })
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, `notify.js failed:\n${child.output.stderr}`);

    const summaries = tg.messages();
    assert.equal(summaries.length, 1, 'exactly one summary, not one per recipient and not twice');
    assert.equal(summaries[0].chatId, ADMIN);
    assert.match(summaries[0].text, /Batch test-batch/);
    assert.ok(
      !summaries.some((message) => message.chatId === CHANNEL),
      'the channel must never receive batch text'
    );

    const photos = tg.photos();
    assert.deepEqual(photos.map((photo) => photo.chatId).sort(), [CHANNEL, ADMIN].sort());
    for (const photo of photos) {
      assert.equal(photo.caption, '01011112222');
    }
  } finally {
    await tg.stop();
  }
});
