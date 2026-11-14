// Starter files written by `/livespec init`. Each must pass `/livespec validate` as written.

import { TEMPLATE_MARKER } from "../core/templates.ts";

export const PRODUCT_TEMPLATE = `# Product

Describe what the product is, who it serves and the problems it solves.
`;

/** Zero entries: entries are added as \`- **Term**: definition\`, in A to Z order. */
export const GLOSSARY_TEMPLATE = "# Glossary\n";

/** The first line is the template marker; removing it marks the file as drafted. */
export const CONSTRAINTS_TEMPLATE = `${TEMPLATE_MARKER}
# Constraints

List the constraints every change must respect: platforms, dependencies, performance, security and compliance.
`;

export const DECISIONS_KEEP_FILE = ".gitkeep";

/** Every key is commented out, so the defaults apply until the user sets one. */
export const CONFIG_TEMPLATE = `# pi-livespec project config. Uncomment a key to set it.
#
# Forge kind; detected from the origin remote when absent.
# forge: github            # github | gitea
# host: github.example.com
# githubHosts: [github.example.com]
# giteaUrl: https://gitea.example.com
#
# Branch that changes merge into; the origin default branch when absent.
# integrationBranch: main
#
# The agent-skills channel is a user setting, read from ~/.pi/agent/livespec/config.yaml only.
`;
