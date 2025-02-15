import { readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { ROOT } from "./env";
import { logger } from "./logger";

// ---------------
// GENERIC HELPERS
// ---------------
export const PATH_TERMINAL_OUT = join(ROOT, ".logs/.terminal_out.log");
export const PATH_BASH_HISTORY = join(ROOT, ".logs/.bash_history.log");
export const PATH_CWD = join(ROOT, ".logs/.cwd.log");
export const PATH_TEMP = join(ROOT, ".logs/.temp.log");

/**
 * @typedef ControlWrapperOptions
 * @type {object}
 * @property {number} timeout
 * @property {number} stepSize
 */

/**
 * Wraps a function in an interval to retry until it succeeds
 * @param {callback} cb Callback to wrap
 * @param {ControlWrapperOptions} options Options to pass to `ControlWrapper`
 * @returns {Promise<any>} Returns the result of the callback or `null`
 */
async function controlWrapper(cb, { timeout = 10000, stepSize = 250 }) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const response = await cb();
        resolve(response);
      } catch (e) {
        logger.debug(e);
      }
    }, stepSize);
    setTimeout(() => {
      clearInterval(interval);
      reject(null);
    }, timeout);
  });
}

/**
 * Get the `.logs/.bash_history.log` file contents
 * @returns {Promise<string>}
 */
async function getBashHistory() {
  const bashHistory = await readFile(PATH_BASH_HISTORY, {
    encoding: "utf8",
    flag: "a+",
  });
  return bashHistory;
}

const execute = promisify(exec);
/**
 * Returns the output of a command called from a given path
 * @param {string} command
 * @param {string} path Path relative to root of working directory
 * @returns {Promise<{stdout, stderr}>}
 */
async function getCommandOutput(command, path = "") {
  const cmdOut = await execute(command, {
    cwd: join(ROOT, path),
    shell: "/bin/bash",
  });
  return cmdOut;
}

/**
 * Get the `.logs/.cwd.log` file contents
 * @returns {Promise<string>}
 */
async function getCWD() {
  const cwd = await readFile(PATH_CWD, {
    encoding: "utf8",
    flag: "a+",
  });
  return cwd;
}

/**
 * Get the `.logs/.bash_history.log` file contents, or `throw` is not found
 * @param {number} howManyBack The `nth` log from the history
 * @returns {Promise<string>}
 */
async function getLastCommand(howManyBack = 0) {
  const bashLogs = await getBashHistory();

  const logs = bashLogs.split("\n").filter((l) => l !== "");
  const lastLog = logs[logs.length - howManyBack - 1];

  return lastLog;
}

/**
 * Get the `.logs/.cwd.log` file contents, or `throw` is not found
 * @param {number} howManyBack The `nth` log from the current working directory history
 * @returns {Promise<string>}
 */
async function getLastCWD(howManyBack = 0) {
  const currentWorkingDirectory = await getCWD();

  const logs = currentWorkingDirectory.split("\n").filter((l) => l !== "");
  const lastLog = logs[logs.length - howManyBack - 1];

  return lastLog;
}

/**
 * Get the `.logs/.temp.log` file contents, or `throw` if not found
 * @returns {Promise<string>} The `.temp.log` file contents
 */
async function getTemp() {
  const tempLogs = await readFile(PATH_TEMP, {
    encoding: "utf8",
    flag: "a+",
  });
  return tempLogs;
}

/**
 * Get the `.logs/.terminal_out.log` file contents, or `throw` if not found
 * @returns {Promise<string>} The `.terminal_out.log` file contents
 */
async function getTerminalOutput() {
  const terminalLogs = await readFile(PATH_TERMINAL_OUT, {
    encoding: "utf8",
    flag: "a+",
  });
  return terminalLogs;
}

/**
 * Imports a module side-stepping Nodejs' cache
 * @param {string} path Path to file/module to import
 * @returns {Promise<ReturnType<typeof import>>}
 */
async function importSansCache(path) {
  const cacheBustingModulePath = `${join(ROOT, path)}?update=${Date.now()}`;
  return await import(cacheBustingModulePath);
}

const __helpers = {
  controlWrapper,
  getBashHistory,
  getCommandOutput,
  getCWD,
  getLastCommand,
  getLastCWD,
  getTemp,
  getTerminalOutput,
  importSansCache,
};

export default __helpers;
