import { mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig.js";

interface AddSkillOptions {
  dir?: string;
  tags?: string;
  description?: string;
  force?: boolean;
}

export async function addSkillCommand(name: string, options: AddSkillOptions) {
  if (!name || name.trim().length === 0) {
    console.error("Error: Skill name is required.");
    process.exit(1);
  }

  // Normalize name: lowercase, hyphens for spaces
  const skillName = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
    console.error(
      "Error: Skill name must be lowercase alphanumeric with hyphens (e.g. 'my-skill')."
    );
    process.exit(1);
  }

  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const skillsDir = vars.SKYNET_SKILLS_DIR || join(devDir, "skills");
  const skillPath = join(skillsDir, `${skillName}.md`);

  if (existsSync(skillPath) && !options.force) {
    console.error(
      `Error: Skill '${skillName}' already exists at ${skillPath}. Use --force to overwrite.`
    );
    process.exit(1);
  }

  mkdirSync(skillsDir, { recursive: true });

  const tags = options.tags ? options.tags.toUpperCase() : "";
  const description = options.description || `Custom skill: ${skillName}`;

  // Title-case the skill name for the heading
  const heading = skillName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const content = `---
name: ${skillName}
description: ${description}
tags: ${tags}
---

## ${heading}

Add your skill instructions here.
`;

  writeFileSync(skillPath, content, "utf-8");

  console.log(`\n  Created skill: .dev/skills/${skillName}.md\n`);
  if (tags) {
    console.log(
      `  Tags: ${tags} (only injected for [${tags.split(",").join("], [")}] tasks)`
    );
  } else {
    console.log("  Tags: (none) — will be injected for ALL tasks");
  }
  console.log(`\n  Edit the file to add your skill instructions.\n`);
}
