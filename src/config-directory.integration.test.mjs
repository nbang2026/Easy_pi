import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// A separate process keeps HOME and Pi overrides out of concurrent test environments.
test("default libraries share the isolated Pi override without touching its default home", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "easy-pi-config-root-"));
  const libraryUrl = new URL("../src-tauri/src/gui-library.mjs", import.meta.url).href;
  const skillsUrl = new URL("../src-tauri/src/gui-skills.mjs", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {access,mkdir,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {createAgentLibrary} from ${JSON.stringify(libraryUrl)};
    import {createSkillLibrary} from ${JSON.stringify(skillsUrl)};
    const library=createAgentLibrary();
    await library.run({kind:'agent',action:'save',title:'Isolated role',content:'Only a synthetic test definition.'});
    assert.equal((await library.run({kind:'agent',action:'list'})).length,1);
    await access(join(process.cwd(),'custom','gui-library','library.json'));
    const skillDirectory=join(process.cwd(),'custom','gui-skills');
    await mkdir(skillDirectory,{recursive:true});
    await writeFile(join(skillDirectory,'registry.json'),JSON.stringify({version:1,revision:41,skills:[]}));
    const skills=createSkillLibrary();
    assert.deepEqual(await skills.run({action:'list'}),{skills:[],revision:41});
    library.dispose(); skills.dispose();
  `;
  try {
    const env = { PATH: process.env.PATH || "", HOME: join(temporary, "home"), USERPROFILE: join(temporary, "home"), PI_CODING_AGENT_DIR: "custom" };
    if (process.platform === "win32") for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: temporary, env });
      let stderr = "";
      child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Configuration-root integration timed out")); }, 10_000);
      child.once("close", code => { clearTimeout(timeout); resolve({ code, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(join(temporary, "home", ".pi")), { code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
