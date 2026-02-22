import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig.js";

interface ListSkillsOptions {
  dir?: string;
}

export async function listSkillsCommand(options: ListSkillsOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const skillsDir = vars.SKYNET_SKILLS_DIR || join(devDir, "skills");

  if (!existsSync(skillsDir)) {
    console.log(
      "\n  No skills directory found. Run 'skynet add-skill <name>' to create one.\n"
    );
    return;
  }

  const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log(
      "\n  No skills found in .dev/skills/. Run 'skynet add-skill <name>' to create one.\n"
    );
    return;
  }

  console.log(`\n  Skills (${files.length}):\n`);

  for (const file of files.sort()) {
    const content = readFileSync(join(skillsDir, file), "utf-8");

    // Parse frontmatter
    let skillName = file.replace(/\.md$/, "");
    let description = "";
    let tags = "(all)";

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)/m);
      const descMatch = fm.match(/^description:\s*(.+)/m);
      const tagsMatch = fm.match(/^tags:\s*(.+)/m);
      if (nameMatch) skillName = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
      if (tagsMatch && tagsMatch[1].trim()) tags = tagsMatch[1].trim();
    }

    console.log(
      `    ${skillName.padEnd(25)} tags: ${tags.padEnd(20)} ${description}`
    );
  }

  console.log("");
}
