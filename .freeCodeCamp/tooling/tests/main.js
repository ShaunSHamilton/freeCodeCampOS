import { assert, AssertionError, expect, config as chaiConfig } from 'chai';
import { watcher } from '../hot-reload.js';
import { logover } from '../logger.js';

import { getProjectConfig, getState, setProjectConfig } from '../env.js';
import { freeCodeCampConfig, ROOT } from '../env.js';
import {
  updateTest,
  updateTests,
  updateConsole,
  updateHints,
  resetBottomPanel,
  handleProjectFinish
} from '../client-socks.js';
import { runLesson } from '../lesson.js';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { pluginEvents } from '../../plugin/index.js';
import { t } from '../t.js';
import { runPython } from './utils.js';

try {
  const plugins = freeCodeCampConfig.tooling?.plugins;
  if (plugins) {
    await import(join(ROOT, plugins));
  }
} catch (e) {
  logover.error('Error importing plugins:');
  logover.error(e);
}

/** @type {Worker[]} */
export const WORKER_POOL = [];

/**
 * Run the given project's tests
 * @param {WebSocket} ws
 * @param {string} projectDashedName
 */
export async function runTests(ws, projectDashedName) {
  // TODO: Consider awaiting in parallel, since both invoke `fs`
  const project = await getProjectConfig(projectDashedName);
  const { locale } = await getState();
  // toggleLoaderAnimation(ws);
  const lessonNumber = project.currentLesson;

  let testsState = [];
  try {
    const lesson = await pluginEvents.getLesson(
      projectDashedName,
      lessonNumber
    );
    const { beforeAll, beforeEach, afterAll, afterEach, hints, tests } = lesson;

    const testers = [beforeAll, beforeEach, afterAll, afterEach, ...tests];
    let firstRunner = testers.filter(t => t !== null).at(0).runner;

    for (const tester of testers) {
      if (!tester) {
        continue;
      }
      const runner = tester.runner;

      if (runner !== firstRunner) {
        throw new Error(
          `All tests and hooks must use the same runner. Found: ${runner}, expected: ${firstRunner}`
        );
      }
    }

    if (beforeAll) {
      try {
        logover.debug('Starting: --before-all-- hook');
        switch (beforeAll.runner) {
          case 'Node':
            await eval(`(async () => {${beforeAll.code}})()`);
            break;
          case 'Python':
            await runPython(beforeAll.code);
            break;
          default:
            throw new Error(`Unsupported runner: ${beforeAll.runner}`);
        }
        logover.debug('Finished: --before-all-- hook');
      } catch (e) {
        logover.error('--before-all-- hook failed to run:');
        logover.error(e);
      }
    }
    // toggleLoaderAnimation(ws);

    testsState = tests.map((t, i) => {
      return {
        passed: false,
        testText: t.text,
        testId: i,
        isLoading: !project.blockingTests
      };
    });

    await pluginEvents.onTestsStart(project, testsState);

    updateTests(ws, testsState);
    updateConsole(ws, '');

    // Create one worker for each test if non-blocking.
    // TODO: See if holding pool of workers is better.
    if (project.blockingTests) {
      const worker = createWorker('blocking-worker', firstRunner, {
        beforeEach,
        project
      });
      WORKER_POOL.push(worker);

      // When result is received back from worker, update the client state
      worker.on('message', workerMessage);
      worker.stdout.on('data', data => {
        logover.debug(`Blocking Worker:`, data.toString());
      });
      worker.on('exit', async exitCode => {
        worker.exited = true;
        removeWorkerFromPool(worker);
        await handleWorkerExit({
          ws,
          exitCode,
          testsState,
          afterEach,
          project,
          hints,
          lessonNumber,
          afterAll
        });
      });

      for (let i = 0; i < tests.length; i++) {
        const { code } = tests[i];
        testsState[i].isLoading = true;
        updateTest(ws, testsState[i]);

        worker.postMessage({ testCode: code, testId: i });
      }
    } else {
      // Run tests in parallel, and in own worker threads
      for (let i = 0; i < tests.length; i++) {
        const { code, runner } = tests[i];
        testsState[i].isLoading = true;
        updateTest(ws, testsState[i]);

        const worker = createWorker(`worker-${i}`, runner, {
          beforeEach,
          project
        });
        WORKER_POOL.push(worker);

        // When result is received back from worker, update the client state
        worker.on('message', workerMessage);
        worker.stdout.on('data', data => {
          logover.debug(`Worker-${i}:`, data.toString());
        });
        worker.on('exit', async exitCode => {
          worker.exited = true;
          removeWorkerFromPool(worker);
          await handleWorkerExit({
            ws,
            exitCode,
            testsState,
            i,
            afterEach,
            project,
            hints,
            lessonNumber,
            afterAll
          });
        });

        worker.postMessage({ testCode: code, testId: i });
      }
    }

    async function workerMessage(message) {
      const { passed, testId, error } = message;
      testsState[testId].isLoading = false;
      testsState[testId].passed = passed;
      if (error) {
        if (error.type !== 'AssertionError') {
          logover.error(`Test #${testId}:`, error);
        }

        if (error.message) {
          const assertionTranslation = await t(error.message, {});
          error.message = assertionTranslation || error.message;
        }

        const consoleError = {
          ...testsState[testId],
          error
        };
        updateConsole(ws, consoleError);
      }
      updateTest(ws, testsState[testId]);

      await checkTestsCallback({
        ws,
        project,
        hints,
        lessonNumber,
        testsState,
        afterAll
      });
    }
  } catch (e) {
    logover.error('Test Error: ');
    logover.error(e);
  }
}

async function checkTestsCallback({
  ws,
  project,
  hints,
  lessonNumber,
  testsState,
  afterAll
}) {
  const passed = testsState.every(test => test.passed);
  if (passed) {
    await pluginEvents.onLessonPassed(project);

    resetBottomPanel(ws);
    if (project.isIntegrated || lessonNumber === project.numberOfLessons - 1) {
      await pluginEvents.onProjectFinished(project);
      await setProjectConfig(project.dashedName, {
        completedDate: Date.now()
      });
      handleProjectFinish(ws);
    } else {
      await setProjectConfig(project.dashedName, {
        currentLesson: lessonNumber + 1
      });
      await runLesson(ws, project.dashedName);
    }
  } else {
    await pluginEvents.onLessonFailed(project);
    updateHints(ws, hints);
  }
  const allTestsFinished = testsState.every(test => !test.isLoading);
  if (allTestsFinished) {
    // Run afterAll hook
    if (afterAll) {
      try {
        logover.debug('Starting: --after-all-- hook');
        switch (afterAll.runner) {
          case 'Node':
            await eval(`(async () => {${afterAll.code}})()`);
            break;
          case 'Python':
            await runPython(afterAll.code);
            break;
          default:
            throw new Error(`Unsupported runner: ${afterAll.runner}`);
        }
        logover.debug('Finished: --after-all-- hook');
      } catch (e) {
        logover.error('--after-all-- hook failed to run:');
        logover.error(e);
      }
    }

    await pluginEvents.onTestsEnd(project, testsState);
    WORKER_POOL.splice(0, WORKER_POOL.length);
  }
}

/**
 * NOTE: Either `handleCancelTests` or `handleWorkerExit` should update `testsState`
 * @param {object} param0
 * @param {number} param0.exitCode
 * @param {Array} param0.testsState
 * @param {number} param0.i
 * @param {{ runner: string; code: string;} | null} param0.afterEach
 * @param {object} param0.error
 * @param {object} param0.project
 * @param {Array} param0.hints
 * @param {{ runner: string; code: string;} | null} param0.afterAll
 * @param {number} param0.lessonNumber
 */
async function handleWorkerExit({
  ws,
  exitCode,
  testsState,
  i,
  afterEach,
  project,
  hints,
  lessonNumber,
  afterAll
}) {
  // If exit code == 1, worker was likely terminated
  // Let client know test was cancelled
  if (exitCode === 1) {
    if (i !== undefined) {
      testsState[i].isLoading = false;
      testsState[i].passed = false;
      const consoleError = {
        ...testsState[i],
        error: 'Tests cancelled.'
      };
      updateConsole(ws, consoleError);
    } else {
      testsState.forEach(test => {
        if (test.isLoading) {
          test.isLoading = false;
          test.passed = false;
          updateConsole(ws, {
            ...test,
            error: 'Tests cancelled.'
          });
        }
      });
    }
    updateTests(ws, testsState);
  }
  // Run afterEach even if tests are cancelled
  // TODO: Double-check this is not run twice
  try {
    if (afterEach) {
      logover.debug('Starting: --after-each-- hook');
      switch (afterEach.runner) {
        case 'Node':
          await eval(`(async () => {${afterEach.code}})()`);
          break;
        case 'Python':
          await runPython(afterEach.code);
          break;
        default:
          throw new Error(`Unsupported runner: ${afterEach.runner}`);
      }
      logover.debug('Finished: --after-each-- hook');
    }
  } catch (e) {
    logover.error('--after-each-- hook failed to run:');
    logover.error(e);
  }
  // Run afterAll even if tests are cancelled
  await checkTestsCallback({
    ws,
    project,
    hints,
    lessonNumber,
    testsState,
    afterAll
  });
}

/**
 *
 * @param {string} name unique name for the worker
 * @param {string} runner runner to use
 * @param {*} workerData
 * @returns {Worker}
 */
function createWorker(name, runner, workerData) {
  return new Worker(
    join(
      ROOT,
      'node_modules/@freecodecamp/freecodecamp-os',
      '.freeCodeCamp/tooling/tests',
      `${runner}.js`
    ),
    {
      name,
      workerData,
      stdout: true,
      stdin: true
    }
  );
}

export function getWorkerPool() {
  return WORKER_POOL;
}

function removeWorkerFromPool(worker) {
  const index = WORKER_POOL.indexOf(worker);
  if (index > -1) {
    WORKER_POOL.splice(index, 1);
  }
}
