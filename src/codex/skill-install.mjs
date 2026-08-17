import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

/** Resolve the Codex user skill directory. */
export function resolveCodexSkillsRoot(environment = process.env) {
  const codexHome = environment.CODEX_HOME ? resolve(environment.CODEX_HOME) : resolve(homedir(), ".codex");
  return resolve(codexHome, "skills");
}

/**
 * Install one packaged skill into a Codex user or project skill root.
 * @param {string} sourceSkillDirectory Packaged skill directory.
 * @param {string} targetSkillsRoot Target skills root.
 * @param {{force?: boolean, name?: string}} [options] Install options.
 * @returns {Promise<string>}
 */
export async function installBridgeSkill(sourceSkillDirectory, targetSkillsRoot, options = {}) {
  const source = resolve(sourceSkillDirectory);
  const name = options.name ?? basename(source);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid skill name '${name}'`);
  const target = resolve(targetSkillsRoot, name);
  await mkdir(dirname(target), { recursive: true });
  if (options.force === true) await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, errorOnExist: options.force !== true, force: options.force === true });
  return target;
}

/**
 * Install several named skills from one packaged skills root.
 * @param {string} sourceSkillsRoot Packaged skill root.
 * @param {string} targetSkillsRoot Target skills root.
 * @param {string[]} names Skill directory names.
 * @param {{force?: boolean}} [options] Install options.
 * @returns {Promise<string[]>}
 */
export async function installBridgeSkills(sourceSkillsRoot, targetSkillsRoot, names, options = {}) {
  const uniqueNames = [...new Set(names)];
  const installed = [];
  for (const name of uniqueNames) {
    installed.push(await installBridgeSkill(resolve(sourceSkillsRoot, name), targetSkillsRoot, { ...options, name }));
  }
  return installed;
}

/** Backward-compatible Consult-only installer. */
export function installConsultSkill(sourceSkillDirectory, targetSkillsRoot, options = {}) {
  return installBridgeSkill(sourceSkillDirectory, targetSkillsRoot, { ...options, name: "consult" });
}
